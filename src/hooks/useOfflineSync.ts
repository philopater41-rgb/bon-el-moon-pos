import { useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { offlineDB } from '@/lib/dexie';

export function useOfflineSync() {
  const { isOnline, setIsOnline } = useAppStore();
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [pendingCount, setPendingCount] = useState(0);

  // A local POS server can be reachable even when the Internet is down, and
  // navigator.onLine can be true when the local server itself has stopped.
  useEffect(() => {
    let disposed = false;
    const checkServer = async () => {
      try {
        const response = await fetch('/api/shifts/active', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!disposed) setIsOnline(response.ok);
      } catch {
        if (!disposed) setIsOnline(false);
      }
    };
    const onConnectivityChange = () => { void checkServer(); };
    window.addEventListener('online', onConnectivityChange);
    window.addEventListener('offline', onConnectivityChange);
    void checkServer();
    const interval = setInterval(checkServer, 10000);
    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener('online', onConnectivityChange);
      window.removeEventListener('offline', onConnectivityChange);
    };
  }, [setIsOnline]);

  // Count pending offline orders
  const refreshPendingCount = useCallback(async () => {
    try {
      const count = await offlineDB.salesOrders
        .where('syncStatus')
        .equals('PENDING')
        .count();
      setPendingCount(count);
    } catch (e) {
      console.error('Error counting pending orders:', e);
    }
  }, []);

  // Set up counter refresh interval
  useEffect(() => {
    const initial = setTimeout(() => { void refreshPendingCount(); }, 0);
    const interval = setInterval(refreshPendingCount, 5000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [refreshPendingCount]);

  // Sync function
  const triggerSync = useCallback(async () => {
    if (!isOnline || syncingRef.current) return;
    syncingRef.current = true;

    try {
      const pendingOrders = await offlineDB.salesOrders
        .where('syncStatus')
        .equals('PENDING')
        .toArray();

      if (pendingOrders.length === 0) return;

      setSyncing(true);
      console.log(`Syncing ${pendingOrders.length} pending orders to server...`);

      // Format orders to match the API expectation
      const ordersToSync = pendingOrders.map((order) => ({
        id: order.id,
        receiptNumber: order.receiptNumber,
        shiftId: order.shiftId,
        tableId: order.tableId,
        customerId: order.customerId || null,
        customerName: order.customerName || null,
        orderType: order.orderType,
        paymentMethod: order.paymentMethod,
        cashOutAmount: order.cashOutAmount || 0,
        cashOutFee: order.cashOutFee || 0,
        status: order.status,
        subtotal: order.subtotal,
        discount: order.discount,
        discountReason: order.discountReason,
        tax: order.tax,
        total: order.total,
        returnStatus: order.returnStatus || 'NONE',
        returnedAmount: order.returnedAmount || 0,
        returnReason: order.returnReason || null,
        createdAt: order.createdAt,
        items: order.items,
      }));

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: ordersToSync }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        // Update local sync status for successfully synced order IDs
        const syncedIds: string[] = data.syncedIds || [];
        for (const id of syncedIds) {
          await offlineDB.salesOrders.update(id, { syncStatus: 'SYNCED' });
        }
        console.log(`Successfully synced ${syncedIds.length} orders`);
        if (data.errors?.length) console.error('Orders waiting for correction:', data.errors);
        window.dispatchEvent(new Event('bon-sync-completed'));
      } else {
        console.error('Batch sync endpoint failed:', data.error);
      }
    } catch (error) {
      console.error('Offline background sync error:', error);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      refreshPendingCount();
    }
  }, [isOnline, refreshPendingCount]);

  // Automatically trigger sync when coming online
  useEffect(() => {
    if (!isOnline) return;
    const initial = setTimeout(() => { void triggerSync(); }, 0);
    const interval = setInterval(() => { void triggerSync(); }, 15000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [isOnline, triggerSync]);

  return {
    isOnline,
    syncing,
    pendingCount,
    triggerSync,
  };
}
