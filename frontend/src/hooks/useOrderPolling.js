import { useState, useEffect, useCallback, useRef } from "react";
import { fetchOrderByToken, getApiErrorMessage } from "../services/api";

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Safe periodic polling hook for live order status updates.
 * Automatically stops polling when order reaches a terminal state.
 */
export function useOrderPolling(token, intervalMs = 5000) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const timerRef = useRef(null);

  const loadOrder = useCallback(
    async (isManual = false) => {
      const clean = String(token || "").trim().toUpperCase();
      if (!clean) {
        setLoading(false);
        return null;
      }

      if (isManual) setRefreshing(true);
      try {
        const res = await fetchOrderByToken(clean);
        if (res?.success && res.order) {
          setOrder(res.order);
          setError(null);
          setLastUpdated(new Date());
          return res.order;
        }
      } catch (err) {
        setError(getApiErrorMessage(err, "Unable to fetch order details."));
      } finally {
        setLoading(false);
        if (isManual) setRefreshing(false);
      }
      return null;
    },
    [token]
  );

  useEffect(() => {
    const clean = String(token || "").trim();
    if (!clean) {
      setOrder(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    loadOrder(false);

    timerRef.current = setInterval(() => {
      setOrder((currentOrder) => {
        if (currentOrder && TERMINAL_STATUSES.includes(currentOrder.status)) {
          return currentOrder;
        }
        loadOrder(false);
        return currentOrder;
      });
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [token, intervalMs, loadOrder]);

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
