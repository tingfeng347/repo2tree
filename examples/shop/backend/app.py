"""Static teaching fixture. Scanning does not import FastAPI or run this file."""
from fastapi import FastAPI, HTTPException

app = FastAPI()


class Inventory:
    def reserve(self, sku: str, quantity: int) -> dict:
        available = self.lookup(sku)
        if available < quantity:
            raise ValueError("insufficient stock")
        for unit in range(quantity):
            self.mark_reserved(sku)
        return {"sku": sku, "reserved": quantity}

    def lookup(self, sku: str) -> int:
        if sku == "missing":
            return 0
        return 20

    def mark_reserved(self, sku: str) -> None:
        audit("reserve", sku)


class OrderService:
    def create(self, sku: str, quantity: int) -> dict:
        validate_quantity(quantity)
        try:
            reservation = inventory.reserve(sku, quantity)
            return self.persist(reservation)
        except ValueError:
            raise HTTPException(409, "stock conflict")
        finally:
            audit("attempt", sku)

    def persist(self, reservation: dict) -> dict:
        def build_id() -> str:
            return "order-001"

        return {"id": build_id(), **reservation}


def validate_quantity(quantity: int) -> None:
    if quantity <= 0:
        raise HTTPException(400, "quantity must be positive")
    if quantity > 10:
        raise HTTPException(400, "at most ten units")


def audit(event: str, sku: str) -> None:
    print(event, sku)


@app.post("/api/orders")
def create_order(sku: str, quantity: int) -> dict:
    return orders.create(sku, quantity)


@app.get("/api/stock/{sku}")
def read_stock(sku: str) -> dict:
    return {"available": inventory.lookup(sku)}


inventory = Inventory()
orders = OrderService()
