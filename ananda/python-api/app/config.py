"""Application settings loaded from environment variables / .env."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "dev"
    log_level: str = "INFO"
    use_mocks: bool = True

    # Impersonal showcase build for prospective clients: mocks + showcase content (agreement p. 2.1).
    showcase_mode: bool = False

    database_url: str = "postgresql+asyncpg://concierge:concierge@localhost:5432/concierge"

    beds24_api_key: str = ""
    beds24_webhook_secret: str = ""
    # Long-life API token (Settings -> Account -> Access) or an invite/refresh token.
    beds24_refresh_token: str = ""
    beds24_token_kind: str = "api_key"  # api_key | invite_code
    beds24_base_url: str = "https://api.beds24.com/v2.1"
    sync_interval_minutes: int = 10

    wazzup_api_key: str = ""
    wazzup_channel_id: str = ""

    telegram_guest_bot_token: str = ""
    telegram_staff_bot_token: str = ""
    staff_chat_id: int = 0

    llm_provider: str = "mock"  # mock | openai | bedrock
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    aws_region: str = "ap-southeast-1"
    bedrock_model_id: str = ""

    # Review platform link for positive feedback (4+); empty -> showcase link is used.
    review_link: str = ""

    telemetry_export_dir: Path = Path("./var/telemetry")


@lru_cache
def get_settings() -> Settings:
    return Settings()
