import asyncio
import time

from backend.engine.middleware.scheduling_guard_middleware import SchedulingGuardMiddleware


class _Req:
    def __init__(self, config, state):
        self.config = config
        self.state = state


def test_wrap_model_call_writes_queue_wait_back_to_configurable():
    middleware = SchedulingGuardMiddleware()
    enqueued_at = int(time.time() * 1000) - 3000
    configurable = {"request_enqueued_at": enqueued_at}
    request = _Req(config={"configurable": configurable}, state={})

    async def _ok_handler(_request):
        return {"ok": True}

    result = asyncio.run(middleware.wrap_model_call(request, _ok_handler))
    assert result == {"ok": True}
    assert request.state["queue_wait_ms"] > 0
    assert configurable["queue_wait_ms"] == request.state["queue_wait_ms"]


def test_wrap_model_call_syncs_retry_count_on_error():
    middleware = SchedulingGuardMiddleware()
    configurable = {"retry_count": 0}
    request = _Req(config={"configurable": configurable}, state={})

    async def _err_handler(_request):
        raise RuntimeError("boom")

    try:
        asyncio.run(middleware.wrap_model_call(request, _err_handler))
    except RuntimeError:
        pass

    assert request.state["retry_count"] == 1
    assert configurable["retry_count"] == 1
