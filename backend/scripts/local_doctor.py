"""Check the local installation: uv run --extra local python scripts/local_doctor.py --probe."""

import argparse
from importlib.metadata import version
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Config
from app.local_runtime import (
    configure_local_environment,
    openai_client_options,
    close_local_gateway,
)
from app.local_runtime.doctor import probe_model_capabilities


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Run small synthetic JSON, tool-calling and embedding requests",
    )
    args = parser.parse_args(argv)
    if not Config.LOCAL_MODE:
        print("Set MEMORY_BACKEND=local (copy .env.local.example to .env first).")
        return 1
    errors = Config.validate()
    if errors:
        print("\n".join(errors))
        return 1
    configure_local_environment()
    try:
        for package in ("camel-ai", "camel-oasis", "graphiti-core", "neo4j", "openai"):
            print(f"{package}: {version(package)}")
        from neo4j import GraphDatabase
        from openai import OpenAI

        auth = (
            (Config.LOCAL_GRAPH_USER, Config.LOCAL_GRAPH_PASSWORD)
            if Config.LOCAL_GRAPH_PASSWORD
            else None
        )
        with GraphDatabase.driver(
            Config.LOCAL_GRAPH_URI, auth=auth, connection_timeout=10
        ) as driver:
            driver.verify_connectivity()
            driver.execute_query(
                "RETURN 1 AS ready", database_=Config.LOCAL_GRAPH_DATABASE
            )
        print("Neo4j: reachable")
        with OpenAI(**openai_client_options()) as client:
            models = client.models.list()
            print(
                "Model server: reachable; installed models: "
                + ", ".join(model.id for model in models.data)
            )
            if args.probe:
                for message in probe_model_capabilities(
                    client,
                    model=Config.LLM_MODEL_NAME,
                    embedding_model=Config.LOCAL_EMBEDDING_MODEL,
                    embedding_dimensions=Config.LOCAL_EMBEDDING_DIMENSIONS,
                ):
                    print(message)
        print(
            "Local checks passed. These checks do not measure simulation quality or predict hardware speed."
        )
        return 0
    except Exception as exc:
        print(f"Local check failed ({type(exc).__name__}): {exc}")
        print(
            "Check docs/LOCAL_MODE.md: start Neo4j/Ollama and install the configured models explicitly. No cloud fallback was used."
        )
        return 1
    finally:
        close_local_gateway()


if __name__ == "__main__":
    raise SystemExit(main())
