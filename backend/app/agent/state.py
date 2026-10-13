from dataclasses import dataclass


@dataclass(frozen=True)
class ExplainResult:
    ok: bool
    error: str | None = None
    category: str | None = None
    plan_rows: int | None = None


@dataclass(frozen=True)
class AgentResult:
    columns: list[str]
    rows: list[list[object]]
    truncated: bool
    elapsed_ms: int


@dataclass(frozen=True)
class GuardStageResult:
    stage: str
    passed: bool
    reason: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {"stage": self.stage, "pass": self.passed, "reason": self.reason}


@dataclass(frozen=True)
class GuardOutcome:
    ok: bool
    sql: str
    report: list[GuardStageResult]
