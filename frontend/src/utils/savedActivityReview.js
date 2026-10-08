// Presentation only: admitted records remain in source order with their exact
// identity and opaque saved details. The captured page is never rewritten.
export function focusSavedActivity(actions, platform = 'all', outcome = 'all') {
  return actions.filter(action => (platform === 'all' || action.platform === platform)
    && (outcome === 'all' || outcome === 'success' && action.success === true
      || outcome === 'failed' && action.success === false || outcome === 'unknown' && action.success === null))
}
