from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from pydantic import BaseModel
from ..db import get_db
from ..deps import LongText, Money, Name, PositiveFloat, get_org_id
from .. import models

router = APIRouter(prefix="/api/materials", tags=["materials"])

class MaterialCreate(BaseModel):
    name: Name
    cost_per_lb: Money
    density_lb_in3: PositiveFloat = 0.283
    description: LongText | None = None

class MaterialResponse(BaseModel):
    id: int
    name: str
    cost_per_lb: float
    density_lb_in3: float
    description: str | None

    class Config:
        from_attributes = True

@router.get("", response_model=List[MaterialResponse])
def list_materials(db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get all materials"""
    return db.query(models.Material).filter(models.Material.organization_id == org_id).all()

@router.post("", response_model=MaterialResponse)
def create_material(payload: MaterialCreate, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Create a new material"""
    material = models.Material(**payload.model_dump(), organization_id=org_id)
    db.add(material)
    db.commit()
    db.refresh(material)
    return material

@router.get("/{material_id}", response_model=MaterialResponse)
def get_material(material_id: int, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get a specific material"""
    material = db.query(models.Material).filter(models.Material.id == material_id, models.Material.organization_id == org_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    return material
