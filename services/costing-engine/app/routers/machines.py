from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from pydantic import BaseModel, Field
from ..db import get_db
from ..deps import LongText, Money, Name, get_org_id
from .. import models

router = APIRouter(prefix="/api/machines", tags=["machines"])

class MachineCreate(BaseModel):
    name: Name
    machine_type: str = Field(default="mill", min_length=1, max_length=50)
    machine_rate_per_hr: Money
    labor_rate_per_hr: Money
    description: LongText | None = None

class MachineResponse(BaseModel):
    id: int
    name: str
    machine_type: str
    machine_rate_per_hr: float
    labor_rate_per_hr: float
    description: str | None

    class Config:
        from_attributes = True

@router.get("", response_model=List[MachineResponse])
def list_machines(db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get all machines"""
    return db.query(models.Machine).filter(models.Machine.organization_id == org_id).all()

@router.post("", response_model=MachineResponse)
def create_machine(payload: MachineCreate, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Create a new machine"""
    machine = models.Machine(**payload.model_dump(), organization_id=org_id)
    db.add(machine)
    db.commit()
    db.refresh(machine)
    return machine

@router.get("/{machine_id}", response_model=MachineResponse)
def get_machine(machine_id: int, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get a specific machine"""
    machine = db.query(models.Machine).filter(models.Machine.id == machine_id, models.Machine.organization_id == org_id).first()
    if not machine:
        raise HTTPException(status_code=404, detail="Machine not found")
    return machine
