/**
 * 返回当前时间按「分钟」取整的时间戳（毫秒），每整分钟更新一次，用于时间分组等场景，避免每秒重渲染。
 */
import { useState, useEffect } from "react";

const MS_PER_MINUTE = 60_000;

function getMinuteTimestamp(): number {
  return Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
}

export function usePreciseMinute(): number {
  const [minuteTs, setMinuteTs] = useState(getMinuteTimestamp);

  useEffect(() => {
    const now = Date.now();
    const nextMinute = Math.ceil(now / MS_PER_MINUTE) * MS_PER_MINUTE;
    const delay = Math.max(100, nextMinute - now);
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const tid = window.setTimeout(() => {
      setMinuteTs(getMinuteTimestamp());
      intervalId = window.setInterval(() => setMinuteTs(getMinuteTimestamp()), MS_PER_MINUTE);
    }, delay);
    return () => {
      window.clearTimeout(tid);
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, []);

  return minuteTs;
}
