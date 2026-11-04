from hashlib import sha256
from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError


hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1, type=Type.ID)
# Equal-cost verification for unknown accounts; never a usable account password.
dummy_hash = hasher.hash("not-an-account-password")


def verify_password(encoded: str, password: str) -> bool:
    try:
        return hasher.verify(encoded, password)
    except (VerificationError, InvalidHashError):
        return False


def token_digest(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()
