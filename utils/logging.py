import logging
import json
from config import LOG_LEVEL

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("musa")

def log_event(event: str, **fields):
    """
    Single-line structured log: event name + JSON fields.
    Use ensure_ascii=False for readable accents.
    """
    try:
        payload = json.dumps(fields, ensure_ascii=False, default=str)
    except Exception:
        payload = str(fields)
    log.info("%s %s", event, payload)
