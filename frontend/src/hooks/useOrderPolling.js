import { useState, useEffect, useCallback, useRef } from "react";
import { fetchOrderByToken, getApiErrorMessage } from "../services/api";

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Safe periodic polling hook for live order status updates scoped to a specific shopSlug.
 * Automatically stops polling when order reaches a terminal state.
 */
export function useOrderPolling(shopSlug, token, intervalMs = 3000) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(Boolean(shopSlug && token));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const timerRef = useRef(null);
  const statusRef = useRef(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadOrder = useCallback(
    async (isManual = false) => {
      const cleanSlug = String(shopSlug || "").trim().toLowerCase();
      const cleanToken = String(token || "").trim().toUpperCase();
      if (!cleanSlug || !cleanToken) {
        setLoading(false);
        return null;
      }

      if (isManual) setRefreshing(true);
      try {
        const res = await fetchOrderByToken(cleanSlug, cleanToken);
        if (res?.success && res.order) {
          statusRef.current = res.order.status;
          setOrder(res.order);
          setError(null);
          setLastUpdated(new Date());
          if (TERMINAL_STATUSES.includes(res.order.status)) {
            stopTimer();
          }
          return res.order;
        }
      } catch (err) {
        setError(getApiErrorMessage(err, "Unable to fetch print job status."));
      } finally {
        setLoading(false);
        if (isManual) setRefreshing(false);
      }
      return null;
    },
    [shopSlug, token, stopTimer]
  );

  useEffect(() => {
    const cleanSlug = String(shopSlug || "").trim();
    const cleanToken = String(token || "").trim();
    if (!cleanSlug || !cleanToken) {
      statusRef.current = null;
      setOrder(null);
      setLoading(false);
      setError(null);
      stopTimer();
      return;
    }

    statusRef.current = null;
    setLoading(true);
    loadOrder(false);

    timerRef.current = setInterval(() => {
      if (statusRef.current && TERMINAL_STATUSES.includes(statusRef.current)) {
        stopTimer();
        return;
      }
      loadOrder(false);
    }, intervalMs);

    return () => {
      stopTimer();
    };
  }, [shopSlug, token, intervalMs, loadOrder, stopTimer]);

  return {
    order,
    setOrder,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh: () => loadOrder(true)
  };
}
