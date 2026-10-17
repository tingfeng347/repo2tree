from fastapi import APIRouter, FastAPI, HTTPException

router = APIRouter(prefix="/items")


class Store:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str) -> str:
        if key not in self.data:
            raise KeyError(key)
        return self.data[key]

    def put(self, key: str, value: str) -> None:
        for ch in key:
            validate_char(ch)
        self.data[key] = value


STORE = Store()


def validate_char(ch: str) -> None:
    if not ch.isalnum():
        raise ValueError(ch)


@router.get("/{key}")
def read_item(key: str) -> dict:
    try:
        value = STORE.get(key)
    except KeyError:
        raise HTTPException(404, "missing")
    return {"key": key, "value": value}


@router.post("/{key}")
def write_item(key: str, value: str) -> dict:
    STORE.put(key, value)
    return {"ok": True}


app = FastAPI()
app.include_router(router, prefix="/api")
