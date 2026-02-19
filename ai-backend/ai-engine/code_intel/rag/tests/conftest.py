"""
Pytest configuration for RAG test suite.

Shared fixtures for temp directories, sample documents, and mock configs.
"""

import os
import tempfile
import shutil
import pytest
from ..config import RAGConfig


@pytest.fixture
def tmp_dir():
    """Create a temporary directory for test storage."""
    d = tempfile.mkdtemp(prefix="rag_test_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def rag_config(tmp_dir):
    """Create a RAGConfig with temp storage directory."""
    config = RAGConfig()
    config.store.store_directory = os.path.join(tmp_dir, ".rag_store")
    return config


@pytest.fixture
def sample_markdown():
    """Sample markdown content for testing."""
    return """# Getting Started

Welcome to the project documentation.

## Installation

Install dependencies:

```bash
pip install -r requirements.txt
```

## Configuration

Set the following environment variables:
- `API_KEY`: Your API key
- `DATABASE_URL`: Database connection string

### Database Setup

Run migrations:

```bash
python manage.py migrate
```

## Usage

Import and create an instance:

```python
from myproject import Client
client = Client(api_key="...")
result = client.query("Hello")
```
"""


@pytest.fixture
def sample_python():
    """Sample Python code for testing."""
    return '''"""
Authentication module.

Handles user login, token management, and session validation.
"""

import hashlib
import secrets
from dataclasses import dataclass
from typing import Optional


@dataclass
class User:
    """Represents an authenticated user."""
    
    id: str
    username: str
    email: str
    role: str = "user"


class AuthManager:
    """Manages authentication and sessions."""
    
    def __init__(self, secret_key: str):
        self._secret = secret_key
        self._sessions = {}
    
    def login(self, username: str, password: str) -> Optional[str]:
        """Authenticate user and return session token."""
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        # Verify against store...
        token = secrets.token_urlsafe(32)
        self._sessions[token] = username
        return token
    
    def validate_session(self, token: str) -> Optional[User]:
        """Validate a session token and return the user."""
        username = self._sessions.get(token)
        if not username:
            return None
        return User(id="1", username=username, email=f"{username}@example.com")
    
    def logout(self, token: str) -> bool:
        """Invalidate a session."""
        return self._sessions.pop(token, None) is not None
'''
