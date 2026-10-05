"""Failure boundary for the pinned camel-oasis 0.2.5 environment.

OASIS returns agent exceptions as values and discards them in Env.step. Keep
its dispatcher and semaphore intact, but report those failures after the whole
LLM step settles. This does not roll back actions or cancel model-server work.
"""

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
import logging


logger = logging.getLogger(__name__)
_step_failures = ContextVar("oasis_step_failures", default=None)


async def _drain_on_cancel(awaitable):
    """Keep ownership of a step until it settles, including repeated cancels."""
    task = asyncio.ensure_future(awaitable)
    cancelled = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as error:
            cancelled = error
        except BaseException:
            break
    if cancelled is not None:
        # Retrieve any secondary failure before propagating the caller's stop.
        if not task.cancelled() and task.exception() is not None:
            logger.error("OASIS step failed while stopping", exc_info=task.exception())
        raise cancelled
    return task.result()


def make_oasis_environment(**kwargs):
    """Construct the checked subclass lazily; importing runners stays optional."""
    from oasis.environment.env import OasisEnv

    class CheckedOasisEnv(OasisEnv):
        async def _perform_llm_action(self, agent):
            try:
                result = await super()._perform_llm_action(agent)
            except Exception as error:
                result = error
            if isinstance(result, Exception):
                failures = _step_failures.get()
                if failures is None:
                    raise result
                failures.append(result)
            return result

        async def step(self, actions):
            failures = []
            token = _step_failures.set(failures)
            try:
                await _drain_on_cancel(super().step(actions))
                if failures:
                    raise failures[0]
            finally:
                _step_failures.reset(token)

    return CheckedOasisEnv(**kwargs)


@asynccontextmanager
async def record_after_step(env, actions):
    """Read persisted actions even on failure, then preserve the step error."""
    failure = None
    try:
        await env.step(actions)
    except BaseException as error:
        failure = error
    try:
        yield
    except BaseException:
        if failure is None:
            raise
        logger.exception("Could not record persisted actions after OASIS failure")
    if failure is not None:
        raise failure


async def close_environment(env, *, failure=None):
    """Clean up without replacing an already-observed action/cancellation error."""
    try:
        await _drain_on_cancel(env.close())
    except BaseException:
        if failure is None:
            raise
        logger.exception("Could not close OASIS environment after failure")


async def gather_platforms(*runs):
    """Stop and drain peers before publishing a parallel run failure."""
    tasks = [asyncio.create_task(run) for run in runs]
    try:
        return await asyncio.gather(*tasks)
    except BaseException as failure:
        for task in tasks:
            if not task.done():
                task.cancel()

        async def cleanup():
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if not isinstance(result, BaseException) and result.env is not None:
                    await close_environment(result.env, failure=failure)

        try:
            await _drain_on_cancel(cleanup())
        except BaseException:
            logger.exception("Secondary failure while draining parallel environments")
        raise
