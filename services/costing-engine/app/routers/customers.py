from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from pydantic import BaseModel, Field
from ..db import get_db
from ..deps import Name, get_org_id
from .. import models

router = APIRouter(prefix="/api/customers", tags=["customers"])

class CustomerCreate(BaseModel):
    name: Name
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=50)

class CustomerResponse(BaseModel):
    id: int
    name: str
    email: str | None
    phone: str | None

    class Config:
        from_attributes = True

@router.get("", response_model=List[CustomerResponse])
def list_customers(db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get all customers"""
    return db.query(models.Customer).filter(models.Customer.organization_id == org_id).all()

@router.post("", response_model=CustomerResponse)
def create_customer(payload: CustomerCreate, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Create a new customer"""
    customer = models.Customer(**payload.model_dump(), organization_id=org_id)
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return customer

@router.get("/{customer_id}", response_model=CustomerResponse)
def get_customer(customer_id: int, db: Session = Depends(get_db), org_id: str = Depends(get_org_id)):
    """Get a specific customer"""
    customer = db.query(models.Customer).filter(models.Customer.id == customer_id, models.Customer.organization_id == org_id).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer
