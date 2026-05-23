"""LineWise inference engine — parses uploaded Damm planning Excels and
returns per-block OEE predictions (p10/p50/p90)."""

from .parse_planning_excel import detect_format, parse_planning_excel
from .build_features import build_feature_rows
from .predict_oee import predict_blocks, MIN_HISTORICAL_RUNS_FOR_FEASIBILITY

__all__ = [
    "detect_format",
    "parse_planning_excel",
    "build_feature_rows",
    "predict_blocks",
    "MIN_HISTORICAL_RUNS_FOR_FEASIBILITY",
]
