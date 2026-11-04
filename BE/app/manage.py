"""Provision test accounts without storing plaintext credentials in the repo."""
import argparse
from getpass import getpass
import sqlite3
from uuid import uuid4

from app.auth.security import hasher
from app.core.config import get_settings
from app.core.database import Database


def create_teacher(database: Database, login_id: str, display_name: str, password: str) -> str:
    if not login_id.strip() or not display_name.strip() or not password.strip():
        raise ValueError("계정 ID·표시 이름·비밀번호를 입력해 주세요.")
    teacher_id = str(uuid4())
    password_hash = hasher.hash(password)
    with database.connect() as connection:
        connection.execute("INSERT INTO teachers VALUES (?,?,?,?,1)",
                           (teacher_id, login_id, display_name, password_hash))
    return teacher_id


def main():
    parser = argparse.ArgumentParser(description="PatPat 테스트 계정 관리")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-teacher")
    create.add_argument("--login-id", required=True)
    create.add_argument("--display-name", required=True)
    args = parser.parse_args()
    password = getpass("비밀번호: ")
    if password != getpass("비밀번호 확인: "):
        parser.error("비밀번호가 일치하지 않습니다.")
    try:
        teacher_id = create_teacher(Database(get_settings().database_path), args.login_id, args.display_name, password)
    except sqlite3.IntegrityError:
        parser.error("이미 등록된 계정 ID입니다.")
    except ValueError as error:
        parser.error(str(error))
    print(f"테스트 계정을 등록했습니다. teacher_id={teacher_id}")


if __name__ == "__main__":
    main()
