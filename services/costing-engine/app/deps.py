import uuid
from typing import Annotated

from fastapi import Header, HTTPException
from pydantic import Field

# Bounded numeric/string types shared by every request model.
Money = Annotated[float, Field(ge=0, le=1_000_000, allow_inf_nan=False)]
Hours = Annotated[float, Field(ge=0, le=100_000, allow_inf_nan=False)]
Fraction = Annotated[float, Field(ge=0, le=5, allow_inf_nan=False)]
PositiveFloat = Annotated[float, Field(gt=0, le=1_000_000, allow_inf_nan=False)]
Quantity = Annotated[int, Field(gt=0, le=1_000_000)]
ShortText = Annotated[str, Field(min_length=1, max_length=120)]
Name = Annotated[str, Field(min_length=1, max_length=200)]
LongText = Annotated[str, Field(max_length=400)]
Notes = Annotated[str, Field(max_length=4000)]


def get_org_id(x_org_id: Annotated[str, Header(alias="X-Org-Id")]) -> str:
    """Tenant id sent by the Tolra proxy (user_profiles.organization_id). Must be a UUID."""
    try:
        return str(uuid.UUID(x_org_id.strip()))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid X-Org-Id")
