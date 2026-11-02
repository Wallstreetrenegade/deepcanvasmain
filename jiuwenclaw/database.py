"""Small SQL compatibility boundary for SQLite development and PostgreSQL production."""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable


def database_url() -> str:
    return os.getenv("DATABASE_URL", "").strip()


def is_postgres() -> bool:
    return database_url().startswith(("postgresql://", "postgres://"))


class Row(dict):
    """Mapping row that also supports SQLite-style numeric indexing."""

    def __init__(self, columns: list[str], values: tuple[Any, ...]) -> None:
        super().__init__(zip(columns, values))
        self._values = values

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


class Cursor:
    def __init__(self, cursor: Any, *, lastrowid: Any = None) -> None:
        self._cursor = cursor
        self.lastrowid = lastrowid

    @property
    def rowcount(self) -> int:
        return int(self._cursor.rowcount)

    def _row(self, value: tuple[Any, ...] | None) -> Row | None:
        if value is None:
            return None
        columns = [item.name for item in self._cursor.description or ()]
        return Row(columns, value)

    def fetchone(self) -> Row | None:
        return self._row(self._cursor.fetchone())

    def fetchall(self) -> list[Row]:
        return [self._row(value) for value in self._cursor.fetchall()]  # type: ignore[misc]


def _postgres_sql(sql: str) -> str:
    query = sql.replace("?", "%s")
    query = re.sub(r"\bLIMIT\s+-1\b", "LIMIT ALL", query, flags=re.IGNORECASE)
    if re.search(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", query, flags=re.IGNORECASE):
        query = re.sub(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", "INSERT INTO", query, flags=re.IGNORECASE)
        query = query.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    return query


class PostgresConnection:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def execute(self, sql: str, params: Iterable[Any] = ()) -> Cursor:
        query = _postgres_sql(sql)
        returns_id = bool(re.match(
            r"\s*INSERT\s+INTO\s+(team_messages|direct_messages)\b",
            query,
            flags=re.IGNORECASE,
        ))
        if returns_id and " returning " not in query.lower():
            query = query.rstrip().rstrip(";") + " RETURNING id"
        cursor = self._connection.cursor()
        cursor.execute(query, tuple(params))
        lastrowid = None
        if returns_id:
            value = cursor.fetchone()
            lastrowid = value[0] if value else None
        return Cursor(cursor, lastrowid=lastrowid)

    def executemany(self, sql: str, params: Iterable[Iterable[Any]]) -> Cursor:
        cursor = self._connection.cursor()
        cursor.executemany(_postgres_sql(sql), [tuple(row) for row in params])
        return Cursor(cursor)

    def executescript(self, script: str) -> None:
        normalized = re.sub(
            r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT",
            "BIGSERIAL PRIMARY KEY",
            script,
            flags=re.IGNORECASE,
        )
        for statement in normalized.split(";"):
            if statement.strip():
                self.execute(statement)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        self._connection.close()


def connect(sqlite_path: Path) -> sqlite3.Connection | PostgresConnection:
    if is_postgres():
        import psycopg

        return PostgresConnection(psycopg.connect(database_url()))
    connection = sqlite3.connect(sqlite_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def is_integrity_error(exc: BaseException) -> bool:
    if isinstance(exc, sqlite3.IntegrityError):
        return True
    try:
        import psycopg

        return isinstance(exc, psycopg.IntegrityError)
    except ImportError:
        return False
