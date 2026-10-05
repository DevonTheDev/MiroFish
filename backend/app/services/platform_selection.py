"""Pure validation for persisted simulation platforms and requested run modes."""


def validate_platform_flags(enable_twitter=True, enable_reddit=True):
    """Keep legacy defaults while rejecting truthy substitutes and empty choices."""
    if type(enable_twitter) is not bool or type(enable_reddit) is not bool:
        raise ValueError("enable_twitter and enable_reddit must be JSON booleans")
    if not (enable_twitter or enable_reddit):
        raise ValueError("At least one simulation platform must be enabled")
    return enable_twitter, enable_reddit


def validate_platform_mode(platform):
    if not isinstance(platform, str) or platform not in ("auto", "twitter", "reddit", "parallel"):
        raise ValueError("platform must be auto, twitter, reddit or parallel")
    return platform


def resolve_platform(platform, enable_twitter=True, enable_reddit=True):
    """Resolve auto from saved flags; explicit modes may only use enabled sites."""
    validate_platform_mode(platform)
    twitter, reddit = validate_platform_flags(enable_twitter, enable_reddit)
    if platform == "auto":
        return "parallel" if twitter and reddit else "twitter" if twitter else "reddit"
    if (platform in ("twitter", "parallel") and not twitter
            or platform in ("reddit", "parallel") and not reddit):
        raise ValueError(f"Requested platform {platform} includes a disabled environment")
    return platform
