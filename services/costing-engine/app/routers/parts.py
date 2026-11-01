from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from typing import List
from pydantic import BaseModel, Field
from ..db import get_db
from ..deps import Fraction, Hours, LongText, Money, ShortText, get_org_id
from .. import models

router = APIRouter(prefix="/api/parts", tags=["parts"])

class OperationCreate(BaseModel):
    machine_id: int
    name: ShortText
    sequence: int = Field(default=10, ge=0, le=100_000)
    setup_time_hr: Hours = 0.5
    cycle_time_hr: Hours = 0.25
    allowance_pct: Fraction = 0.10
    # Enhanced fields
    operation_type: str = Field(default="machining", min_length=1, max_length=20)
    tool_cost_per_part: Money = 0.0
    tool_change_time_min: Hours = 0.0
    inspection_time_min: Hours = 0.0
    consumables_cost_per_part: Money = 0.0

class OperationResponse(BaseModel):
    id: int
    machine_id: int
    name: str
    sequence: int
    setup_time_hr: float
    cycle_time_hr: float
    allowance_pct: float
    operation_type: str
    tool_cost_per_part: float
    tool_change_time_min: float
    inspection_time_min: float
    consumables_cost_per_part: float

    class Config:
        from_attributes = True

class PartCreate(BaseModel):
    part_number: ShortText
    description: LongText | None = None
    material_id: int
    stock_weight_lb: Hours = 1.0
    scrap_factor: Fraction = 0.05
    # Enhanced fields
    programming_time_hr: Hours = 0.0
    programming_rate_per_hr: Money = 75.0
    first_article_inspection_hr: Hours = 0.0
    overhead_rate_pct: Fraction = 1.5
    operations: List[OperationCreate] = Field(default=[], max_length=200)

class PartUpdate(BaseModel):
    part_number: ShortText | None = None
    description: LongText | None = None
    material_id: int | None = None
    stock_weight_lb: Hours | None = None
    scrap_factor: Fraction | None = None
    programming_time_hr: Hours | None = None
    programming_rate_per_hr: Money | None = None
    first_article_inspection_hr: Hours | None = None
    overhead_rate_pct: Fraction | None = None

class PartResponse(BaseModel):
    id: int
    part_number: str
    description: str | None
    material_id: int
    stock_weight_lb: float
    scrap_factor: float
    programming_time_hr: float
    programming_rate_per_hr: float
    first_article_inspection_hr: float
    overhead_rate_pct: float
    operations: List[OperationResponse] = []

    class Config:
        from_attributes = True

def _require_material(db: Session, org_id: str, material_id: int):
    if not db.query(models.Material.id).filter(models.Material.id == material_id, models.Material.organization_id == org_id).first():
        raise HTTPException(status_code=404, detail="Material not found")

def _require_machine(db: Session, org_id: str, machine_id: int):
    if not db.query(models.Machine.id).filter(models.Machine.id == machine_id, models.Machine.organization_id == org_id).first():
        raise HTTPException(status_code=404, detail="Machine not found")

def _part_in_org(db: Session, org_id: str, part_id: int, with_operations: bool = False):
    query = db.query(models.Part)
    if with_operations:
        query = query.options(joinedload(models.Part.operations))
    part = query.filter(models.Part.id == part_id, models.Part.organization_id == org_id).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part not found")
    return part

@router.get("", response_model=List[PartResponse])
def list_parts(db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get all parts with operations"""
    return db.query(models.Part).options(joinedload(models.Part.operations)).filter(models.Part.organization_id == org_id).all()

@router.post("", response_model=PartResponse)
def create_part(payload: PartCreate, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Create a new part with operations"""

    # Check if part number already exists in this organization
    existing = db.query(models.Part).filter(
        models.Part.organization_id == org_id,
        models.Part.part_number == payload.part_number,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Part number {payload.part_number} already exists")

    _require_material(db, org_id, payload.material_id)
    for op_data in payload.operations:
        _require_machine(db, org_id, op_data.machine_id)

    # Create part
    part_data = payload.model_dump(exclude={"operations"})
    part = models.Part(**part_data, organization_id=org_id)
    db.add(part)
    db.flush()

    # Create operations
    for op_data in payload.operations:
        operation = models.Operation(part_id=part.id, **op_data.model_dump())
        db.add(operation)

    db.commit()
    db.refresh(part)
    return part

@router.get("/{part_id}", response_model=PartResponse)
def get_part(part_id: int, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get a specific part with operations"""
    return _part_in_org(db, org_id, part_id, with_operations=True)

@router.put("/{part_id}", response_model=PartResponse)
def update_part(part_id: int, payload: PartUpdate, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Update an existing part"""
    part = _part_in_org(db, org_id, part_id)

    # Update only provided fields
    update_data = payload.model_dump(exclude_unset=True)
    if "material_id" in update_data:
        _require_material(db, org_id, update_data["material_id"])
    if update_data.get("part_number") and update_data["part_number"] != part.part_number:
        clash = db.query(models.Part.id).filter(
            models.Part.organization_id == org_id,
            models.Part.part_number == update_data["part_number"],
        ).first()
        if clash:
            raise HTTPException(status_code=400, detail=f"Part number {update_data['part_number']} already exists")
    for field, value in update_data.items():
        setattr(part, field, value)

    db.commit()
    db.refresh(part)
    return part

@router.put("/{part_id}/operations/{operation_id}")
def update_operation(part_id: int, operation_id: int, payload: OperationCreate, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Update an existing operation"""
    _part_in_org(db, org_id, part_id)
    _require_machine(db, org_id, payload.machine_id)
    operation = db.query(models.Operation).filter(
        models.Operation.id == operation_id,
        models.Operation.part_id == part_id
    ).first()

    if not operation:
        raise HTTPException(status_code=404, detail="Operation not found")

    # Update all fields
    update_data = payload.model_dump()
    for field, value in update_data.items():
        setattr(operation, field, value)

    db.commit()
    db.refresh(operation)
    return operation
