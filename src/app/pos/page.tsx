'use client';

import { useState, useEffect, useCallback, useSyncExternalStore, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useAppStore } from '@/lib/store';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { createBarcodeScanner } from '@/lib/barcode-scanner';
import { parseWeightInput } from '@/lib/weight-quantity';
import {
  offlineDB,
  type LocalCategory,
  type LocalItem,
  type LocalModifier,
  type LocalHall,
  type LocalTable,
  type LocalSalesOrder,
  type LocalCart,
  type LocalCartItem,
  type LocalCustomer,
  type LocalDiscountReason,
  type PaymentMethodType,
} from '@/lib/dexie';
import { 
  Coffee, LogOut, Wifi, WifiOff, Users, ShoppingBag, 
  Trash2, Plus, Minus, DollarSign, RefreshCw, 
  CheckCircle2, AlertCircle, X, PlusCircle, Printer, Lock,
  CreditCard, Smartphone, RotateCcw, UserPlus, Search, Wallet, Database
} from 'lucide-react';
import { NeonSpinner, NeonBadge } from '@/components/NeonSpinner';

const subscribeHydration = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;
const scheduleEffect = (work: () => void) => {
  let cancelled = false;
  queueMicrotask(() => { if (!cancelled) work(); });
  return () => { cancelled = true; };
};

interface POSInitialization {
  categories: Array<LocalCategory & { items: Array<Pick<LocalItem, 'id' | 'name' | 'price' | 'barcode' | 'stock' | 'tracksInventory'>> }>;
  modifiers: LocalModifier[];
  halls: Array<LocalHall & { tables: Array<Pick<LocalTable, 'id' | 'name' | 'status'>> }>;
  customers?: LocalCustomer[];
  discountReasons?: LocalDiscountReason[];
  todayOrdersCount?: number;
}
interface ReturnableOrder {
  id: string;
  receiptNumber: string | null;
  createdAt: string;
  total: number;
  paymentMethod: PaymentMethodType;
  items: Array<{ itemId: string; qty: number; totalPrice: number }>;
}

// Native browser UUID
const currentTimestamp = (): number => Date.now();

const generateUUID = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const generateReceiptNumber = (): string => {
  const now = new Date();
  const dateKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const receiptDate = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    now.getFullYear(),
  ].join('-');
  const counterKey = `bon_receipt_counter_${dateKey}`;
  const nextNumber = Number.parseInt(localStorage.getItem(counterKey) || '0', 10) + 1;
  localStorage.setItem(counterKey, String(nextNumber));
  return `BON-${receiptDate}-${String(nextNumber).padStart(4, '0')}`;
};

export default function POSPage() {
  const router = useRouter();
  const {
    user,
    activeShift,
    setActiveShift,
    isOnline,
    activeHallId,
    activeTableId,
    setActiveHallId,
    setActiveTableId,
    logout,
  } = useAppStore();
  const { pendingCount, syncing, triggerSync } = useOfflineSync();

  // Local state for POS data loaded from Dexie
  const [loadingPOS, setLoadingPOS] = useState(true);
  const [categories, setCategories] = useState<LocalCategory[]>([]);
  const [items, setItems] = useState<LocalItem[]>([]);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [uncertainOrder, setUncertainOrder] = useState<LocalSalesOrder | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const confirmingOrderRef = useRef(false);
  const [verificationMessage, setVerificationMessage] = useState('لم يتأكد رد الخادم على الفاتورة. أعد المحاولة للتحقق من نفس الفاتورة قبل إجراء بيع آخر.');
  useEffect(() => { return scheduleEffect(() => { try { const saved = localStorage.getItem('bon_uncertain_stock_order'); if (saved) setUncertainOrder(JSON.parse(saved)); } catch { /* Keep the lock until the saved transaction is investigated. */ } }); }, []);
  const [menuSearch, setMenuSearch] = useState('');
  const draggedCategory = useRef<string | null>(null);
  const scannerHandler = useRef<(code: string) => void>(() => {});
  const [modifiers, setModifiers] = useState<LocalModifier[]>([]);
  const [halls, setHalls] = useState<LocalHall[]>([]);
  const [tables, setTables] = useState<LocalTable[]>([]);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [discountReasons, setDiscountReasons] = useState<LocalDiscountReason[]>([]);

  // Selected category in menu
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  // Active cart (Takeaway or Table cart)
  const [cart, setCart] = useState<LocalCart | null>(null);

  // Customer selection in Cart
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustType, setNewCustType] = useState('INDIVIDUAL');
  const [newCustDiscount, setNewCustDiscount] = useState('0');
  const [newCustNotes, setNewCustNotes] = useState('');
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Payment Method selection & Cashout
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('CASH');
  const [cashOutAmount, setCashOutAmount] = useState('');
  const [cashOutFee, setCashOutFee] = useState('0');
  const cashOutValue = Number(cashOutAmount);
  const cashOutCharge = Number(cashOutFee || 0);
  const cashOutValid = Number.isFinite(cashOutValue) && cashOutValue > 0 && Number.isFinite(cashOutCharge) && cashOutCharge >= 0;
  const payableAmount = paymentMethod === 'CASH_OUT' && cashOutValid ? cashOutValue + cashOutCharge : (cart?.total || 0);

  // Modals
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [showModifiersModal, setShowModifiersModal] = useState(false);
  const [activeItemForMod, setActiveItemForMod] = useState<LocalItem | null>(null);
  const [selectedMods, setSelectedMods] = useState<string[]>([]);
  const [itemComment, setItemComment] = useState('');

  // Returns / Refund Modal
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnSearchQuery, setReturnSearchQuery] = useState('');
  const [recentCompletedOrders, setRecentCompletedOrders] = useState<ReturnableOrder[]>([]);
  const [selectedReturnOrder, setSelectedReturnOrder] = useState<ReturnableOrder | null>(null);
  const [returnReason, setReturnReason] = useState('طلب العميل');
  const [returnRestock, setReturnRestock] = useState(true);
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // Existing shift from server

  // Shift inputs
  const [floatCash, setFloatCash] = useState('0');
  const [closedCash, setClosedCash] = useState('');
  const [closedInstaPay, setClosedInstaPay] = useState('');
  const [closedVisa, setClosedVisa] = useState('');
  const [closedVodafoneCash, setClosedVodafoneCash] = useState('');
  const [cashierName, setCashierName] = useState('');
  const [savedCashierNames, setSavedCashierNames] = useState<Array<{ id: string; name: string }>>([]);

  // Expense inputs
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseReason, setExpenseReason] = useState('');

  // POS Action inputs
  const [discountVal, setDiscountVal] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  // Receipt print state
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [showPaymentConfirm, setShowPaymentConfirm] = useState(false);
  const [receiptOrder, setReceiptOrder] = useState<LocalSalesOrder | null>(null);

  // Mobile responsiveness tab
  const [mobileTab, setMobileTab] = useState<'menu' | 'cart'>('menu');

  // Loading & Alert status
  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const mounted = useSyncExternalStore(subscribeHydration, getClientSnapshot, getServerSnapshot);
  useEffect(() => {
    // Check active shift from server
    const checkServerShift = async () => {
      try {
        const res = await fetch('/api/shifts/active');
        if (res.ok) {
          const data = await res.json();
          if (data.activeShift) {
            const pending = await offlineDB.salesOrders.where('syncStatus').equals('PENDING').count();
            if (pending === 0) setActiveShift(data.activeShift);
          }
        }
      } catch (e) {
        console.error('Failed to check active shift:', e);
      }
    };

    // Fetch saved cashier names
    const fetchCashierNames = async () => {
      try {
        const res = await fetch('/api/cashier-names');
        if (res.ok) {
          const data = await res.json();
          setSavedCashierNames(data.cashierNames || []);
        }
      } catch (e) {
        console.error('Failed to fetch cashier names:', e);
      }
    };

    checkServerShift();
    fetchCashierNames();
  }, [setActiveShift]);

  // Do not replace local totals with server totals while sales are pending.
  useEffect(() => {
    const refreshShift = async () => {
      if (!useAppStore.getState().isOnline) return;
      try {
        if (await offlineDB.salesOrders.where('syncStatus').equals('PENDING').count()) return;
        const response = await fetch('/api/shifts/active');
        if (!response.ok) return;
        const data = await response.json();
        if (data.activeShift && !(await offlineDB.salesOrders.where('syncStatus').equals('PENDING').count())) setActiveShift(data.activeShift);
      } catch (error) {
        console.error('Failed to refresh shift:', error);
      }
    };
    window.addEventListener('bon-sync-completed', refreshShift);
    if (showCloseShift) void refreshShift();
    return () => window.removeEventListener('bon-sync-completed', refreshShift);
  }, [showCloseShift, setActiveShift]);

  const handleAutoFillExpected = () => {
    if (!activeShift) return;
    setClosedCash(String((activeShift.expectedCash || 0).toFixed(2)));
    setClosedInstaPay(String((activeShift.expectedInstaPay || 0).toFixed(2)));
    setClosedVisa(String((activeShift.expectedVisa || 0).toFixed(2)));
    setClosedVodafoneCash(String((activeShift.expectedVodafoneCash || 0).toFixed(2)));
  };

  const triggerAlert = (type: 'success' | 'error', text: string) => {
    setAlertMsg({ type, text });
    setTimeout(() => setAlertMsg(null), 4000);
  };

  const ensureActiveShift = useCallback((): boolean => {
    if (!activeShift) {
      triggerAlert('error', 'يجب فتح وردية جديدة أولاً لبدء العمل والبيع.');
      setShowOpenShift(true);
      return false;
    }
    return true;
  }, [activeShift]);

  // Load POS initialization data
  const loadPOSData = useCallback(async () => {
    setLoadingPOS(true);
    try {
      if (isOnline) {
        const res = await fetch('/api/pos-init').catch(() => null);
        if (res?.ok) {
          const data: POSInitialization = await res.json();

          await offlineDB.transaction('rw', [offlineDB.categories, offlineDB.items, offlineDB.modifiers, offlineDB.halls, offlineDB.diningTables, offlineDB.customers, offlineDB.discountReasons], async () => {
          await offlineDB.categories.clear();
          await offlineDB.items.clear();
          await offlineDB.modifiers.clear();
          await offlineDB.halls.clear();
          await offlineDB.diningTables.clear();

          if (data.customers) {
            await offlineDB.customers.clear();
            await offlineDB.customers.bulkPut(data.customers);
          }
          if (data.discountReasons) {
            await offlineDB.discountReasons.clear();
            await offlineDB.discountReasons.bulkPut(data.discountReasons);
          }

          await offlineDB.categories.bulkPut(data.categories.map((c) => ({ id: c.id, name: c.name })));

          const allItems: LocalItem[] = [];
          data.categories.forEach((c) => {
            c.items.forEach((i) => {
              allItems.push({ id: i.id, name: i.name, price: i.price, barcode: i.barcode, stock: i.stock, tracksInventory: i.tracksInventory, categoryId: c.id });
            });
          });
          await offlineDB.items.bulkPut(allItems);

          await offlineDB.modifiers.bulkPut(data.modifiers);
          await offlineDB.halls.bulkPut(data.halls.map((h) => ({ id: h.id, name: h.name })));

          const allTables: LocalTable[] = [];
          data.halls.forEach((h) => {
            h.tables.forEach((t) => {
              allTables.push({ id: t.id, name: t.name, hallId: h.id, status: t.status });
            });
          });
          await offlineDB.diningTables.bulkPut(allTables);

          });

          if (typeof data.todayOrdersCount === 'number') {
            const now = new Date();
            const dateKey = [
              now.getFullYear(),
              String(now.getMonth() + 1).padStart(2, '0'),
              String(now.getDate()).padStart(2, '0'),
            ].join('');
            const counterKey = `bon_receipt_counter_${dateKey}`;
            const currentLocal = Number.parseInt(localStorage.getItem(counterKey) || '0', 10);
            if (data.todayOrdersCount > currentLocal) {
              localStorage.setItem(counterKey, String(data.todayOrdersCount));
            }
          }
        }
      }

      // Load from Dexie
      const [dbCats, dbItems, dbMods, dbHalls, dbTables, dbCustomers, dbReasons] = await Promise.all([
        offlineDB.categories.toArray(),
        offlineDB.items.toArray(),
        offlineDB.modifiers.toArray(),
        offlineDB.halls.toArray(),
        offlineDB.diningTables.toArray(),
        offlineDB.customers.toArray(),
        offlineDB.discountReasons.toArray(),
      ]);

      const openTableIds = new Set(
        (await offlineDB.carts.toArray())
          .filter((localCart) => localCart.orderType === 'DINE_IN' && localCart.items.length > 0 && localCart.tableId)
          .map((localCart) => localCart.tableId!)
      );
      const resolvedTables = dbTables.map((table) =>
        openTableIds.has(table.id) ? { ...table, status: 'OCCUPIED' } : table
      );

      await offlineDB.diningTables.bulkPut(resolvedTables);

      const orderedCategories = [...dbCats].sort((a, b) => {
        if (a.name === 'خدمات') return 1;
        if (b.name === 'خدمات') return -1;
        return a.name.localeCompare(b.name, 'ar');
      });

      const savedOrder: string[] = (() => { try { const value = JSON.parse(localStorage.getItem('bon_category_order') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } })();
      orderedCategories.sort((a, b) => { const ai = savedOrder.indexOf(a.id), bi = savedOrder.indexOf(b.id); return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi); });
      setCategories(orderedCategories);
      setItems(dbItems);
      setModifiers(dbMods);
      setHalls(dbHalls);
      setTables(resolvedTables);
      setCustomers(dbCustomers);
      setDiscountReasons(dbReasons);

      if (orderedCategories.length > 0) setSelectedCategoryId(current => current || orderedCategories[0].id);
      const currentHallId = useAppStore.getState().activeHallId;
      if (dbHalls.length > 0 && (!currentHallId || !dbHalls.some((hall) => hall.id === currentHallId))) {
        setActiveHallId(dbHalls[0].id);
      }
    } catch (error) {
      console.error('Error loading POS data:', error);
    } finally {
      setLoadingPOS(false);
    }
  }, [isOnline, setActiveHallId]);

  useEffect(() => {
    return scheduleEffect(() => { void loadPOSData(); });
  }, [loadPOSData]);

  // Load Cart
  const loadCart = useCallback(async (id: string, type: 'DINE_IN' | 'TAKEAWAY', tableName: string | null = null) => {
    try {
      let localCart = await offlineDB.carts.get(id);
      if (!localCart) {
        localCart = {
          id,
          orderType: type,
          tableId: type === 'DINE_IN' ? id : null,
          tableName: type === 'DINE_IN' ? tableName : 'تيك أواي',
          items: [],
          subtotal: 0,
          discount: 0,
          discountRate: 0,
          tax: 0,
          total: 0,
          updatedAt: Date.now(),
        };
        await offlineDB.carts.put(localCart);
      }
      if ((useAppStore.getState().activeTableId || 'takeaway') !== id) return;
      setCart(localCart);
      setSelectedCustomerId(localCart.customerId || '');
      setDiscountReason(localCart.discountReason || '');
      setDiscountVal(localCart.discountRate && localCart.discountRate > 0 ? localCart.discountRate.toString() : '');
    } catch (e) {
      console.error('Error loading cart:', e);
    }
  }, [setDiscountReason]);

  useEffect(() => {
    return scheduleEffect(() => {
      if (activeTableId) {
        const activeTable = tables.find((t) => t.id === activeTableId);
        void loadCart(activeTableId, 'DINE_IN', activeTable?.name || null);
      } else void loadCart('takeaway', 'TAKEAWAY');
    });
  }, [activeTableId, tables, loadCart]);

  // Save and Recalculate Cart
  const saveAndRecalculateCart = async (
    updatedItems: LocalCartItem[],
    customDiscountRate: number | null = null,
    extraFields?: Partial<LocalCart>
  ) => {
    if (!cart) return;

    const subtotal = updatedItems.reduce((acc, item) => acc + item.totalPrice, 0);
    const rate = customDiscountRate !== null ? customDiscountRate : (cart.discountRate || 0);
    const disc = Math.round((subtotal * (rate / 100)) * 100) / 100;
    const tax = 0;
    const total = Math.max(0, subtotal - disc);

    const updatedCart: LocalCart = {
      ...cart,
      items: updatedItems,
      subtotal,
      discount: disc,
      discountRate: rate,
      tax,
      total,
      updatedAt: currentTimestamp(),
      ...extraFields,
    };

    await offlineDB.carts.put(updatedCart);
    if ((useAppStore.getState().activeTableId || 'takeaway') === updatedCart.id) setCart(updatedCart);
  };

  const addItemToCartDirectly = async (
    item: LocalItem,
    selectedModList: LocalModifier[],
    customUnitPrice?: number,
    comment = '',
    quantity = 1
  ) => {
    if (!cart) return;
    if (item.stock) {
      const inCart = cart.items.filter(line => line.itemId === item.id).reduce((sum, line) => sum + line.qty, 0);
      if (inCart + quantity > item.stock.quantity + 1e-8) { triggerAlert('error', `المخزون المتاح للصنف ${item.name}: ${item.stock.quantity} ${item.stock.unit}`); return; }
    }

    const modPriceImpact = selectedModList.reduce((acc, m) => acc + m.priceImpact, 0);
    const unitPrice = customUnitPrice ?? (item.price + modPriceImpact);

    const existingIndex = cart.items.findIndex(
      (ci) =>
        ci.itemId === item.id &&
        ci.unitPrice === unitPrice &&
        (ci.comment || '') === comment &&
        ci.modifiers.length === selectedModList.length &&
        ci.modifiers.every((cm) => selectedModList.some((sm) => sm.id === cm.modifierId))
    );

    const updatedItems = [...cart.items];

    if (existingIndex > -1) {
      const existing = updatedItems[existingIndex];
      updatedItems[existingIndex] = {
        ...existing,
        qty: Math.round((existing.qty + quantity) * 1000) / 1000,
        totalPrice: (Math.round((existing.qty + quantity) * 1000) / 1000) * unitPrice,
      };
    } else {
      const newItem: LocalCartItem = {
        id: generateUUID(),
        itemId: item.id,
        name: item.name,
        qty: quantity,
        unitPrice,
        totalPrice: quantity * unitPrice,
        comment: comment || null,
        modifiers: selectedModList.map((m) => ({
          modifierId: m.id,
          name: m.name,
          unitPriceImpact: m.priceImpact,
        })),
      };
      updatedItems.push(newItem);
    }

    await saveAndRecalculateCart(updatedItems);

    if (cart.orderType === 'DINE_IN' && cart.tableId) {
      await offlineDB.diningTables.update(cart.tableId, { status: 'OCCUPIED' });
      setTables((prev) => prev.map((t) => (t.id === cart.tableId ? { ...t, status: 'OCCUPIED' } : t)));
    }
  };


  const askWeight = (item: LocalItem): number | null => {
    if (!item.stock || !['kg', 'g'].includes(item.stock.unit)) return 1;
    const stockUnit = item.stock.unit as 'kg' | 'g';
    const unit = stockUnit === 'kg' ? 'كيلوجرام؛ مثال 0.25 أو 250 جرام' : 'جرام؛ مثال 250 أو 0.25 كيلو';
    const input = window.prompt(`أدخل كمية ${item.name} بـ${unit}`, '');
    if (input === null) return null;
    const quantity = parseWeightInput(input, stockUnit);
    if (quantity === null) { triggerAlert('error', 'أدخل وزنًا صحيحًا أكبر من صفر، مثل 0.25 كيلو أو 250 جرام.'); return null; }
    return quantity;
  };

  // Add Item to Cart
  const handleItemClick = (item: LocalItem) => {
    if (!ensureActiveShift()) return;
    if (!cart || cart.id !== (useAppStore.getState().activeTableId || 'takeaway')) { triggerAlert('error', 'جاري تحميل السلة، حاول مرة أخرى'); return; }
    if (item.name === 'حجز عيد ميلاد') {
      const enteredPrice = window.prompt('اكتب قيمة حجز عيد الميلاد', '');
      if (enteredPrice === null) return;
      const price = Number(enteredPrice);
      if (!Number.isFinite(price) || price <= 0) {
        triggerAlert('error', 'اكتب قيمة حجز صحيحة أكبر من صفر.');
        return;
      }
      void addItemToCartDirectly(item, [], price);
      return;
    }

    const quantity = askWeight(item);
    if (quantity !== null) void addItemToCartDirectly(item, [], undefined, "", quantity);
  };

  const handleBarcode = (value: string) => {
    const code = value.trim();
    if (!code) return;
    const item = items.find(i => i.barcode === code);
    if (!item) { triggerAlert('error', `الباركود ${code} غير مسجل لأي صنف`); return; }
    handleItemClick(item);
  };
  useEffect(() => {
    scannerHandler.current = code => {
      if (showOpenShift || showCloseShift || showExpenseModal || showModifiersModal || showReturnModal || showPrintModal || showPaymentConfirm || showAddCustomerModal) return;
      handleBarcode(code);
    };
  });
  useEffect(() => {
    const scanner = createBarcodeScanner(code => scannerHandler.current(code));
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName || '') || event.ctrlKey || event.altKey || event.metaKey) {
        scanner.cancel();
        return;
      }
      if (scanner.feed(event.key) && event.key === 'Enter') event.preventDefault();
    };
    const cancel = () => scanner.cancel();
    window.addEventListener('keydown', onKey);
    window.addEventListener('focusin', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      scanner.cancel();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focusin', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  // Open modifiers modal for customization
  const handleOpenModifiers = (e: React.MouseEvent, item: LocalItem) => {
    e.stopPropagation();
    if (!ensureActiveShift()) return;
    if (!cart || cart.id !== (useAppStore.getState().activeTableId || 'takeaway')) { triggerAlert('error', 'جاري تحميل السلة، حاول مرة أخرى'); return; }
    setActiveItemForMod(item);
    setSelectedMods([]);
    setItemComment('');
    setShowModifiersModal(true);
  };

  const confirmModifiers = () => {
    if (!activeItemForMod) return;
    const selectedModObjects = modifiers.filter((m) => selectedMods.includes(m.id));
    const quantity = askWeight(activeItemForMod);
    if (quantity === null) return;
    void addItemToCartDirectly(activeItemForMod, selectedModObjects, undefined, itemComment.trim(), quantity);
    setShowModifiersModal(false);
    setActiveItemForMod(null);
    setItemComment('');
  };

  const handleUpdateQty = async (cartItemId: string, delta: number) => {
    if (!cart) return;
    const target = cart.items.find(line => line.id === cartItemId);
    const product = items.find(item => item.id === target?.itemId);
    const weighted = product?.stock && ['kg', 'g'].includes(product.stock.unit);
    const step = weighted ? (product.stock?.unit === 'kg' ? 0.25 : 1) : 1;
    if (target && product?.stock && delta > 0 && cart.items.filter(line => line.itemId === product.id).reduce((sum, line) => sum + line.qty, 0) + step > product.stock.quantity + 1e-8) { triggerAlert('error', `المتاح ${product.stock.quantity} ${product.stock.unit}`); return; }
    const updatedItems = cart.items.map((item) => {
      if (item.id === cartItemId) {
        const newQty = Math.round((item.qty + delta * step) * 1000) / 1000;
        if (newQty <= 0) return item;
        return {
          ...item,
          qty: newQty,
          totalPrice: newQty * item.unitPrice,
        };
      }
      return item;
    });
    await saveAndRecalculateCart(updatedItems);
  };

  const handleRemoveItem = async (cartItemId: string) => {
    if (!cart) return;
    const updatedItems = cart.items.filter((item) => item.id !== cartItemId);
    await saveAndRecalculateCart(updatedItems);

    if (updatedItems.length === 0 && cart.orderType === 'DINE_IN' && cart.tableId) {
      await offlineDB.diningTables.update(cart.tableId, { status: 'VACANT' });
      setTables((prev) => prev.map((t) => (t.id === cart.tableId ? { ...t, status: 'VACANT' } : t)));
    }
  };

  const handleClearCart = async () => {
    if (!cart) return;
    await saveAndRecalculateCart([], 0, {
      customerId: null,
      customerName: null,
      discountReason: null,
    });

    if (cart.orderType === 'DINE_IN' && cart.tableId) {
      await offlineDB.diningTables.update(cart.tableId, { status: 'VACANT' });
      setTables((prev) => prev.map((t) => (t.id === cart.tableId ? { ...t, status: 'VACANT' } : t)));
    }
    setDiscountVal('');
    setDiscountReason('');
    setSelectedCustomerId('');
  };

  // Discount Handlers
  const handleDiscountChange = (value: string) => {
    setDiscountVal(value);
    if (!cart) return;

    const enteredDiscount = value === '' ? 0 : Number(value);
    if (!Number.isFinite(enteredDiscount) || enteredDiscount < 0) return;

    const discount = Math.min(enteredDiscount, 100);
    if (discount !== enteredDiscount) setDiscountVal(String(discount));
    void saveAndRecalculateCart(cart.items, discount);
  };

  // Customer Select Handler
  const handleSelectCustomer = async (custId: string, newCustomer?: LocalCustomer) => {
    setSelectedCustomerId(custId);
    if (!custId) {
      await saveAndRecalculateCart(cart?.items || [], 0, { customerId: null, customerName: null, discountReason: null });
      setDiscountVal('');
      setDiscountReason('');
      return;
    }

    const customer = newCustomer ?? customers.find((c) => c.id === custId);
    if (customer) {
      const discount = customer.discountRate || 0;
      setDiscountVal(String(discount));
      const reasonLabel = `خصم ${getCustomerTypeLabel(customer.type)} - ${customer.name}`;
      setDiscountReason(reasonLabel);
      await saveAndRecalculateCart(cart?.items || [], discount, {
        customerId: customer.id,
        customerName: customer.name,
        discountReason: reasonLabel,
      });
      triggerAlert('success', `تم تطبيق خصم ${discount}% الخاص بالعميل ${customer.name}`);
    }
  };

  const getCustomerTypeLabel = (type: string) => {
    switch (type) {
      case 'COMPANY': return 'شركات';
      case 'HOSPITAL': return 'مستشفيات';
      case 'CAFE': return 'كافيهات';
      case 'INDIVIDUAL': return 'زبون مميز';
      default: return 'عميل';
    }
  };

  // Quick Add Customer Modal Submit
  const handleQuickAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustName.trim()) return;
    setSavingCustomer(true);
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newCustName.trim(),
          phone: newCustPhone.trim() || null,
          type: newCustType,
          discountRate: parseFloat(newCustDiscount) || 0,
          notes: newCustNotes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل حفظ العميل');

      await offlineDB.customers.put(data.customer);
      setCustomers((prev) => [...prev, data.customer]);
      await handleSelectCustomer(data.customer.id, data.customer);
      setShowAddCustomerModal(false);
      setNewCustName('');
      setNewCustPhone('');
      setNewCustDiscount('0');
      setNewCustNotes('');
      triggerAlert('success', 'تمت إضافة العميل وتطبيقه على الفاتورة بنجاح!');
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message || 'خطأ في إضافة العميل');
    } finally {
      setSavingCustomer(false);
    }
  };

  // 5. Complete / Place Order
  const handleCompleteOrder = async () => {
    if (confirmingOrderRef.current) return;
    if (!cart || (!uncertainOrder && paymentMethod !== 'CASH_OUT' && cart.items.length === 0)) {
      triggerAlert('error', 'الفاتورة فاضية مقدرش أقفلها');
      return;
    }
    if (!uncertainOrder && paymentMethod === 'CASH_OUT' && (cart.items.length > 0 || !cashOutValid)) {
      triggerAlert('error', 'الكاش آوت عملية منفصلة: أفرغ السلة واكتب مبلغ السحب والعمولة بشكل صحيح');
      return;
    }

    if (!activeShift) {
      triggerAlert('error', 'مفيش شفت مفتوح حالياً. لازم تفتح الشفت الأول.');
      setShowOpenShift(true);
      return;
    }

    if (!uncertainOrder && cart.discount > 0 && !discountReason.trim()) {
      triggerAlert('error', 'اكتب أو اختر سبب الخصم قبل إتمام الفاتورة.');
      return;
    }

    try {
      const orderId = generateUUID();
      const clientCustomer = customers.find((c) => c.id === selectedCustomerId);

      const isCashOut = paymentMethod === 'CASH_OUT';
      const cOutAmt = isCashOut ? cashOutValue : 0;
      const cOutFee = isCashOut ? cashOutCharge : 0;

      const newOrder: LocalSalesOrder = uncertainOrder || {
        id: orderId,
        receiptNumber: generateReceiptNumber(),
        shiftId: activeShift.id,
        tableId: cart.tableId,
        customerId: clientCustomer?.id || null,
        customerName: clientCustomer?.name || null,
        orderType: cart.orderType,
        paymentMethod,
        cashOutAmount: isCashOut ? cOutAmt : undefined,
        cashOutFee: isCashOut ? cOutFee : undefined,
        status: 'COMPLETED',
        subtotal: isCashOut ? payableAmount : cart.subtotal,
        discount: isCashOut ? 0 : cart.discount,
        discountReason: cart.discount > 0 ? discountReason.trim() : null,
        tax: cart.tax,
        total: isCashOut ? payableAmount : cart.total,
        createdAt: new Date().toISOString(),
        items: cart.items.map((i) => ({
          id: i.id,
          itemId: i.itemId,
          qty: i.qty,
          unitPrice: i.unitPrice,
          totalPrice: i.totalPrice,
          comment: i.comment || null,
          modifiers: i.modifiers.map((m) => ({
            modifierId: m.modifierId,
            unitPriceImpact: m.unitPriceImpact,
          })),
        })),
        syncStatus: 'PENDING',
      };

      const tracked = newOrder.items.some(line => items.find(item => item.id === line.itemId)?.tracksInventory !== false || line.modifiers.length > 0);
      const mustVerify = Boolean(uncertainOrder) || tracked || (isOnline && newOrder.items.length > 0);
      if (mustVerify) {
        if (!isOnline) { triggerAlert('error', 'يلزم الاتصال بالخادم لتأكيد بيع أصناف المخزون ومنع بيع أكثر من المتاح.'); return; }
        confirmingOrderRef.current = true;
        setConfirmingOrder(true);
        localStorage.setItem('bon_uncertain_stock_order', JSON.stringify(newOrder));
        setUncertainOrder(newOrder);
        let response: Response;
        try { response = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orders: [newOrder] }) }); }
        catch { confirmingOrderRef.current = false; setConfirmingOrder(false); setVerificationMessage('تعذر الوصول للخادم. أعد المحاولة للتحقق من نفس الفاتورة بعد الاتصال.'); return; }
        let result: { syncedIds?: string[]; errors?: Array<{ message: string }> };
        try { result = await response.json(); } catch { confirmingOrderRef.current = false; setConfirmingOrder(false); setVerificationMessage('رد الخادم غير واضح. أعد المحاولة للتحقق من نفس الفاتورة.'); return; }
        if (!response.ok || !result.syncedIds?.includes(newOrder.id)) {
          const message = result.errors?.[0]?.message || 'تعذر التأكد من الفاتورة؛ أعد المحاولة بنفس الفاتورة.';
          if (response.ok && (message.includes('المخزون غير كاف') || message.includes('كمية الصنف غير صالحة'))) { localStorage.removeItem('bon_uncertain_stock_order'); setUncertainOrder(null); void loadPOSData(); triggerAlert('error', message); } else { setVerificationMessage(message); }
          confirmingOrderRef.current = false; setConfirmingOrder(false); return;
        }
        newOrder.syncStatus = 'SYNCED';
      }
      // Persist the confirmed order before releasing the retry lock.
      const wasAlreadyStored = (await offlineDB.salesOrders.get(newOrder.id))?.syncStatus === 'SYNCED';
      await offlineDB.salesOrders.put(newOrder);

      // 2. Local shift statistics updates
      if (activeShift && !wasAlreadyStored) {
        const updatedExpected = { ...activeShift };
        const orderNet = newOrder.total;
        if (paymentMethod === 'CASH') {
          updatedExpected.expectedCash = (updatedExpected.expectedCash || 0) + orderNet;
        } else if (paymentMethod === 'INSTAPAY') {
          updatedExpected.expectedInstaPay = (updatedExpected.expectedInstaPay || 0) + orderNet;
        } else if (paymentMethod === 'VISA') {
          updatedExpected.expectedVisa = (updatedExpected.expectedVisa || 0) + orderNet;
        } else if (paymentMethod === 'VODAFONE_CASH') {
          updatedExpected.expectedVodafoneCash = (updatedExpected.expectedVodafoneCash || 0) + orderNet;
        } else if (paymentMethod === 'CASH_OUT') {
          const handedCash = cOutAmt;
          updatedExpected.expectedCash = (updatedExpected.expectedCash || 0) - handedCash;
          updatedExpected.expectedVisa = (updatedExpected.expectedVisa || 0) + orderNet;
          updatedExpected.expectedCashOut = (updatedExpected.expectedCashOut || 0) + handedCash;
        }
        setActiveShift(updatedExpected);
      }

      // 3. Set table status to VACANT
      if (cart.orderType === 'DINE_IN' && cart.tableId) {
        await offlineDB.diningTables.update(cart.tableId, { status: 'VACANT' });
        setTables((prev) => prev.map((t) => (t.id === cart.tableId ? { ...t, status: 'VACANT' } : t)));
      }

      // Clear active cart
      const orderCartId = newOrder.tableId || 'takeaway';
      await offlineDB.carts.delete(orderCartId);
      if (mustVerify) { localStorage.removeItem('bon_uncertain_stock_order'); setUncertainOrder(null); confirmingOrderRef.current = false; setConfirmingOrder(false); void loadPOSData(); }
      setCart({
        ...cart,
        items: [],
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 0,
        customerId: null,
        customerName: null,
        discountReason: null,
      });
      setDiscountVal('0');
      setDiscountReason('');
      setSelectedCustomerId('');
      setCashOutAmount('');
      setCashOutFee('0');
      setPaymentMethod('CASH');

      // 4. Trigger print
      setReceiptOrder(newOrder);
      setShowPrintModal(true);
      setTimeout(() => {
        window.print();
      }, 150);

      triggerAlert('success', 'تم حفظ الأوردر وتقفيل الحساب!');
      triggerSync();
    } catch (e) {
      confirmingOrderRef.current = false; setConfirmingOrder(false);
      console.error('Failed to complete order:', e);
      triggerAlert('error', 'حصل خطأ ومقدرناش نحفظ الأوردر.');
    }
  };

  // Returns / Refund Handler
  const openReturnModal = async () => {
    setShowReturnModal(true);
    setSelectedReturnOrder(null);
    try {
      const res = await fetch('/api/sales-orders?take=20');
      if (res.ok) {
        const data = await res.json();
        setRecentCompletedOrders(data.orders || []);
      }
    } catch (e) {
      console.error('Failed to load recent orders for returns:', e);
    }
  };

  const handleProcessReturn = async () => {
    if (!selectedReturnOrder || !activeShift) return;
    setSubmittingReturn(true);
    try {
      const res = await fetch('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: selectedReturnOrder.id,
          receiptNumber: selectedReturnOrder.receiptNumber,
          shiftId: activeShift.id,
          refundAmount: selectedReturnOrder.total,
          paymentMethod: selectedReturnOrder.paymentMethod === 'CASH_OUT' ? 'VISA' : (selectedReturnOrder.paymentMethod || 'CASH'),
          reason: returnReason.trim(),
          cashierName: activeShift.cashierName || user?.name,
          restockItems: returnRestock,
          items: selectedReturnOrder.items.map((oi) => ({
            itemId: oi.itemId,
            quantity: oi.qty,
            refundPrice: oi.totalPrice,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشلت عملية الإرجاع');

      const updatedShift = { ...activeShift };
      const refund = selectedReturnOrder.total;
      if (selectedReturnOrder.paymentMethod === 'CASH') updatedShift.expectedCash -= refund;
      else if (selectedReturnOrder.paymentMethod === 'VISA') updatedShift.expectedVisa -= refund;
      else if (selectedReturnOrder.paymentMethod === 'INSTAPAY') updatedShift.expectedInstaPay -= refund;
      else if (selectedReturnOrder.paymentMethod === 'VODAFONE_CASH') updatedShift.expectedVodafoneCash = (updatedShift.expectedVodafoneCash || 0) - refund;
      setActiveShift(updatedShift);

      triggerAlert('success', `تم إرجاع الفاتورة ${selectedReturnOrder.receiptNumber} بنجاح!`);
      setShowReturnModal(false);
      setSelectedReturnOrder(null);
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message || 'خطأ في معالجة المرتجع');
    } finally {
      setSubmittingReturn(false);
    }
  };

  // Open shift submit
  const handleOpenShiftSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalCashierName = cashierName.trim() || user?.name || 'كاشير';

    try {
      const res = await fetch('/api/shifts/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user?.id,
          cashierName: finalCashierName,
          floatCash: parseFloat(floatCash) || 0,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل فتح الوردية');

      setActiveShift(data.shift);
      setSavedCashierNames((prev) => {
        if (!prev.some((c) => c.name === finalCashierName)) {
          return [...prev, { id: finalCashierName, name: finalCashierName }];
        }
        return prev;
      });
      setShowOpenShift(false);
      triggerAlert('success', `تم فتح الوردية بنجاح! أهلاً بك يا ${finalCashierName}`);
    } catch (caught: unknown) {
      console.warn('Failed to open shift online, falling back to offline shift:', caught);
      // Offline fallback: create local shift so cashier is never blocked from selling
      const offlineShift = {
        id: `offline-shift-${Date.now()}`,
        userId: user?.id || 'cashier',
        cashierName: finalCashierName,
        floatCash: parseFloat(floatCash) || 0,
        expectedCash: parseFloat(floatCash) || 0,
        expectedInstaPay: 0,
        expectedVisa: 0,
        expectedVodafoneCash: 0,
        expectedCashOut: 0,
        openedAt: new Date().toISOString(),
      };
      setActiveShift(offlineShift);
      setSavedCashierNames((prev) => {
        if (!prev.some((c) => c.name === finalCashierName)) {
          return [...prev, { id: finalCashierName, name: finalCashierName }];
        }
        return prev;
      });
      setShowOpenShift(false);
      triggerAlert('success', `تم فتح الوردية محلياً (وضع عدم الاتصال). أهلاً بك يا ${finalCashierName}`);
    }
  };

  // Register shift expense submit
  const handleExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShift) {
      triggerAlert('error', 'يجب أن تكون هناك وردية مفتوحة لتسجيل المصروف');
      return;
    }

    const amountNum = parseFloat(expenseAmount);
    if (!amountNum || amountNum <= 0) {
      triggerAlert('error', 'برجاء كتابة مبلغ صحيح للمصروف');
      return;
    }

    if (!expenseReason.trim()) {
      triggerAlert('error', 'برجاء كتابة سبب أو بيان المصروف');
      return;
    }

    try {
      const res = await fetch('/api/shifts/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shiftId: activeShift.id,
          type: 'PAYOUT',
          amount: amountNum,
          reason: expenseReason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تسجيل المصروف');

      // Deduct from local activeShift expectedCash immediately
      setActiveShift({
        ...activeShift,
        expectedCash: (activeShift.expectedCash || 0) - amountNum,
      });

      triggerAlert('success', `تم تسجيل مصروف بقيمة ${amountNum.toFixed(2)} ج.م (${expenseReason.trim()})`);
      setExpenseAmount('');
      setExpenseReason('');
      setShowExpenseModal(false);
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message || 'خطأ في تسجيل المصروف');
    }
  };

  // Close shift submit
  const handleCloseShiftSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShift) return;

    try {
      await triggerSync();
      if (await offlineDB.salesOrders.where('syncStatus').equals('PENDING').count()) {
        throw new Error('لا يمكن إغلاق الوردية قبل مزامنة كل الفواتير المعلقة');
      }
      const res = await fetch('/api/shifts/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shiftId: activeShift.id,
          closedCash: parseFloat(closedCash) || 0,
          closedInstaPay: parseFloat(closedInstaPay) || 0,
          closedVisa: parseFloat(closedVisa) || 0,
          closedVodafoneCash: parseFloat(closedVodafoneCash) || 0,
        }),
      });

      if (!res.ok) throw new Error('فشل إغلاق الوردية');

      setActiveShift(null);
      setShowCloseShift(false);
      triggerAlert('success', 'تم تقفيل اليومية والوردية بنجاح!');
      router.push('/');
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message || 'خطأ في إغلاق الوردية');
    }
  };

  // Printable receipt helpers
  const getPaymentMethodArabic = (method: string) => {
    switch (method) {
      case 'VISA': return 'فيزا (Visa)';
      case 'INSTAPAY': return 'إنستا باي (InstaPay)';
      case 'VODAFONE_CASH': return 'فودافون كاش (Vodafone)';
      case 'CASH_OUT': return 'سحب كاش بالفيزا';
      case 'CASH':
      default: return 'نقدي (كاش)';
    }
  };

  const ReceiptLayout = ({ preview = false }: { preview?: boolean }) => {
    if (!receiptOrder) return null;

    return (
      <div className={`receipt-layout ${preview ? 'receipt-preview' : ''}`} dir="rtl">
        <div className="receipt-brand">
          <Image width={128} height={128} unoptimized loading="eager" src="/bon-logo.jpg" alt="BON el MOON" className="receipt-logo" />
        </div>

        <div className="receipt-meta-grid">
          <div className="receipt-meta-wide"><span>رقم الفاتورة</span><strong className="receipt-number">{receiptOrder.receiptNumber}</strong></div>
          <div className="receipt-meta-cell"><span>تاريخ</span><strong>{new Date(receiptOrder.createdAt).toLocaleDateString()}</strong></div>
          <div className="receipt-meta-cell"><span>وقت</span><strong>{new Date(receiptOrder.createdAt).toLocaleTimeString()}</strong></div>
          <div className="receipt-meta-cell"><span>الكاشير</span><strong>{activeShift?.cashierName || user?.name}</strong></div>
          <div className="receipt-meta-cell"><span>طريقة الدفع</span><strong>{getPaymentMethodArabic(receiptOrder.paymentMethod)}</strong></div>
          {receiptOrder.paymentMethod === 'CASH_OUT' && <><div className="receipt-meta-cell"><span>الكاش المصروف</span><strong>{(receiptOrder.cashOutAmount || 0).toFixed(2)}</strong></div><div className="receipt-meta-cell"><span>العمولة</span><strong>{(receiptOrder.cashOutFee || 0).toFixed(2)}</strong></div></>}
          {receiptOrder.customerName && (
            <div className="receipt-meta-wide"><span>العميل</span><strong>{receiptOrder.customerName}</strong></div>
          )}
          <div className="receipt-meta-cell"><span>النوع</span><strong>{receiptOrder.orderType === 'DINE_IN' ? 'صالة' : 'تيك أواي'}</strong></div>
          <div className="receipt-meta-cell"><span>الترابيزة</span><strong>{receiptOrder.tableId ? (tables.find(t => t.id === receiptOrder.tableId)?.name || 'طاولة') : '-'}</strong></div>
        </div>

        <table className="receipt-items-table">
          <colgroup><col className="receipt-item-name" /><col className="receipt-item-price" /><col className="receipt-item-qty" /><col className="receipt-item-total" /></colgroup>
          <thead>
            <tr><th>الصنف</th><th>سعر</th><th>الكمية</th><th>إجمالي</th></tr>
          </thead>
          <tbody>
            {receiptOrder.items.map((item, idx) => {
              const itDetails = items.find(i => i.id === item.itemId);
              const additionsTotal = item.modifiers.reduce((sum, modifier) => sum + modifier.unitPriceImpact, 0);
              const baseUnitPrice = item.unitPrice - additionsTotal;

              return (
                <tr key={idx}>
                  <td>{itDetails?.name || 'صنف'}{item.comment && <span className="receipt-addition">{item.comment}</span>}{item.modifiers.length > 0 && <span className="receipt-addition">إضافة {additionsTotal.toFixed(2)}</span>}</td>
                  <td>{baseUnitPrice.toFixed(2)}</td>
                  <td>{item.qty} {itDetails?.stock?.unit === 'kg' ? 'كجم' : itDetails?.stock?.unit === 'g' ? 'جرام' : 'قطعة'}</td>
                  <td>{item.totalPrice.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <table className="receipt-totals-table">
          <tbody>
            <tr><th>الإجمالي:</th><td>{receiptOrder.subtotal.toFixed(2)}</td></tr>
            {receiptOrder.discount > 0 && (
              <tr className="receipt-discount">
                <th>الخصم {receiptOrder.discountReason ? `(${receiptOrder.discountReason})` : ''}:</th>
                <td>-{receiptOrder.discount.toFixed(2)}</td>
              </tr>
            )}
            <tr className="receipt-final-total"><th>المطلوب دفعه:</th><td>{receiptOrder.total.toFixed(2)}</td></tr>
          </tbody>
        </table>

        <div className="receipt-footer">
          {`طريقة الدفع: ${getPaymentMethodArabic(receiptOrder.paymentMethod)}`}<br />
          شكراً لزيارتكم!
        </div>
      </div>
    );
  };

  const BaristaKotLayout = ({ preview = false }: { preview?: boolean }) => {
    if (!receiptOrder) return null;
    const totalQtyCount = receiptOrder.items.reduce((sum, item) => sum + item.qty, 0);
    const tableName = receiptOrder.tableId ? (tables.find((t) => t.id === receiptOrder.tableId)?.name || 'طاولة') : null;
    const orderTypeLabel = receiptOrder.orderType === 'DINE_IN' ? `صالة${tableName ? ` - ${tableName}` : ''}` : 'تيك أواي';
    const cashierNameText = activeShift?.cashierName || user?.name || 'كاشير';
    const timeFormatted = new Date(receiptOrder.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
      <div className={`kot-layout ${preview ? 'receipt-preview' : ''}`} dir="rtl">
        <div className="kot-box kot-order-num">{receiptOrder.receiptNumber}</div>
        <div className="kot-box kot-order-type">{orderTypeLabel}</div>
        <div className="kot-box kot-cashier">كاشير: {cashierNameText}</div>

        <table className="kot-table">
          <thead>
            <tr>
              <th className="kot-item-name-col">الصنف</th>
              <th className="kot-item-qty-col">الكمية</th>
            </tr>
          </thead>
          <tbody>
            {receiptOrder.items.map((item, idx) => {
              const itDetails = items.find((i) => i.id === item.itemId);
              return (
                <tr key={idx}>
                  <td className="kot-item-name-col">
                    {itDetails?.name || 'صنف'}
                    {item.modifiers.length > 0 && <span className="receipt-addition">إضافات: {item.modifiers.map(mod => modifiers.find(candidate => candidate.id === mod.modifierId)?.name || 'إضافة').join('، ')}</span>}
                    {item.comment && <span className="receipt-addition">ملاحظة: {item.comment}</span>}
                  </td>
                  <td className="kot-item-qty-col">{item.qty} {itDetails?.stock?.unit === 'kg' ? 'كجم' : itDetails?.stock?.unit === 'g' ? 'جرام' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="kot-footer-grid">
          <div className="kot-footer-cell">{timeFormatted}</div>
          <div className="kot-footer-cell flex items-center justify-center gap-1">
            <span>عدد الأصناف</span>
            <strong className="mr-1">{totalQtyCount}</strong>
          </div>
        </div>
      </div>
    );
  };

  if (!mounted) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#0c0907] text-gray-200 text-right" dir="rtl">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-screen bg-[#0c0907] text-gray-200 text-right no-print" dir="rtl">
        {/* 1. Header Navigation Bar */}
        <header className="h-16 shrink-0 bg-[#1c140f] border-b border-white/5 px-4 sm:px-6 flex items-center justify-between z-10 no-print">
          <div className="flex items-center gap-3">
            <div className="w-24 h-12 rounded-xl overflow-hidden relative border border-amber-500/20 shrink-0 bg-[#1c140f] shadow-md">
              <Image width={128} height={128} unoptimized loading="eager" src="/brand-color.jpeg" alt="بن المون" className="w-full h-full object-contain" />
            </div>
            <div className="hidden sm:block text-right">
              <h1 className="text-base font-bold text-white leading-tight">BON el MOON - نقطة البيع</h1>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4 flex-row-reverse overflow-x-auto py-1">
            {loadingPOS && (
              <div className="shrink-0">
                <NeonBadge label="جاري تحديث البيانات..." />
              </div>
            )}
            <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-semibold shrink-0 ${
              isOnline ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
            }`}>
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isOnline ? 'أونلاين' : 'محلي (أوفلاين)'}</span>
            </div>

            {pendingCount > 0 && (
              <div role="status" className="shrink-0 rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-bold text-amber-300" title="فواتير محفوظة محلياً وتنتظر المزامنة">
                {syncing ? 'جاري المزامنة' : 'فواتير معلقة'}: {pendingCount}
              </div>
            )}

            {/* Returns Modal Button */}
            <button
              onClick={openReturnModal}
              className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-[10px] sm:text-xs font-semibold text-rose-400 border border-rose-500/20 transition-all shrink-0 flex items-center gap-1"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>مرتجع فاتورة</span>
            </button>

            {/* Expense Modal Button */}
            {activeShift && (
              <button
                onClick={() => setShowExpenseModal(true)}
                className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-[10px] sm:text-xs font-semibold text-amber-400 border border-amber-500/20 transition-all shrink-0 flex items-center gap-1"
                title="تسجيل مصروف أو نثريات من الدرج"
              >
                <DollarSign className="w-3.5 h-3.5" />
                <span>تسجيل مصروف</span>
              </button>
            )}

            {/* Admin link */}
            {user?.role === 'ADMIN' && (
              <button 
                onClick={() => router.push('/admin')}
                className="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[10px] sm:text-xs font-semibold border border-white/5 transition-all text-white shrink-0"
              >
                شاشة الإدارة
              </button>
            )}

            {activeShift ? (
              <div className="flex items-center gap-2 shrink-0">
                {/* All payment methods expected counters */}
                <div className="flex items-center gap-1.5 bg-slate-900/90 border border-white/10 rounded-xl p-1 text-xs shadow-inner shrink-0">
                  <div className="flex items-center gap-1 text-emerald-400 font-bold bg-emerald-500/10 px-2 py-1 rounded-lg border border-emerald-500/20" title="الكاش المتوقع في الدرج">
                    <span className="text-[10px] text-emerald-300/80 font-normal">كاش:</span>
                    <span className="font-mono font-bold">{(activeShift.expectedCash || 0).toFixed(0)} ج</span>
                  </div>
                  <div className="flex items-center gap-1 text-cyan-400 font-bold bg-cyan-500/10 px-2 py-1 rounded-lg border border-cyan-500/20" title="إنستا باي المتوقع">
                    <span className="text-[10px] text-cyan-300/80 font-normal">إنستا:</span>
                    <span className="font-mono font-bold">{(activeShift.expectedInstaPay || 0).toFixed(0)} ج</span>
                  </div>
                  <div className="flex items-center gap-1 text-purple-400 font-bold bg-purple-500/10 px-2 py-1 rounded-lg border border-purple-500/20" title="الفيزا المتوقعة">
                    <span className="text-[10px] text-purple-300/80 font-normal">فيزا:</span>
                    <span className="font-mono font-bold">{(activeShift.expectedVisa || 0).toFixed(0)} ج</span>
                  </div>
                  <div className="flex items-center gap-1 text-amber-400 font-bold bg-amber-500/10 px-2 py-1 rounded-lg border border-amber-500/20" title="فودافون كاش المتوقع">
                    <span className="text-[10px] text-amber-300/80 font-normal">فودافون:</span>
                    <span className="font-mono font-bold">{(activeShift.expectedVodafoneCash || 0).toFixed(0)} ج</span>
                  </div>
                </div>

                <button 
                  onClick={() => setShowCloseShift(true)}
                  className="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-[10px] sm:text-xs font-semibold text-rose-300 border border-rose-500/20 transition-all shrink-0 flex items-center gap-1"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>تقفيل الوردية</span>
                </button>
              </div>
            ) : (
              <button 
                onClick={() => setShowOpenShift(true)}
                className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 text-xs font-bold text-white shadow-lg transition-all animate-pulse"
              >
                فتح وردية جديدة
              </button>
            )}

            <button 
              onClick={() => { logout(); router.push('/'); }}
              className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-all border border-white/5"
              title="تسجيل الخروج"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        <nav aria-label="التنقل في نقطة البيع" className="lg:hidden flex shrink-0 gap-2 p-2 bg-[#1c140f] border-b border-white/10">
          <button type="button" onClick={() => setMobileTab('menu')} aria-pressed={mobileTab === 'menu'} className={`flex-1 rounded-lg py-2 text-sm font-bold ${mobileTab === 'menu' ? 'bg-cyan-600 text-white' : 'bg-white/5 text-gray-300'}`}>المنيو والطاولات</button>
          <button type="button" onClick={() => setMobileTab('cart')} aria-pressed={mobileTab === 'cart'} className={`flex-1 rounded-lg py-2 text-sm font-bold ${mobileTab === 'cart' ? 'bg-cyan-600 text-white' : 'bg-white/5 text-gray-300'}`}>السلة ({cart?.items.reduce((sum, item) => sum + item.qty, 0) || 0})</button>
        </nav>

        {/* 2. Main POS Workspace */}
        <main className="flex-1 flex flex-col lg:flex-row overflow-hidden no-print">
          {/* Tables & Items Grid */}
          <section className={`flex-1 flex flex-col p-4 overflow-hidden gap-4 ${mobileTab === 'menu' ? 'flex' : 'hidden lg:flex'}`}>
            {/* Floor Plan */}
            <div className="glass-panel rounded-xl p-4 shrink-0 flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-white/5 pb-2 flex-row-reverse">
                <form onSubmit={e => { e.preventDefault(); handleBarcode(barcodeInput); setBarcodeInput(''); }} className="flex gap-2 mb-3" role="search">
                <input aria-label="باركود المنتج" value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)} placeholder="امسح الباركود أو اكتبه هنا" autoComplete="off" dir="ltr" className="min-w-0 flex-1 rounded-xl border border-amber-500/40 bg-slate-950 px-3 py-2 text-sm text-white" />
                <button type="submit" className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white">إضافة بالباركود</button>
                <button type="button" onClick={() => void loadPOSData()} disabled={loadingPOS} className="rounded-xl border border-amber-500/40 px-3 py-2 text-xs text-amber-300 disabled:opacity-40">تحديث المنيو</button>
              </form>
              <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-400" />
                  <h2 className="font-semibold text-sm text-white">صالات وترابيزات الصالة</h2>
                </div>
                <button 
                  onClick={() => { if (!ensureActiveShift()) return; if (useAppStore.getState().activeTableId !== null) { setCart(null); setActiveTableId(null); } }}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border transition-all ${
                    !activeTableId ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-white/5 text-gray-400 border-white/5 hover:bg-white/10'
                  }`}
                >
                  <ShoppingBag className="w-3.5 h-3.5" />
                  <span>تيك أواي / سفري</span>
                </button>
              </div>

              <div className="flex gap-2 justify-start overflow-x-auto pb-1">
                {halls.map((hall) => (
                  <button
                    key={hall.id}
                    onClick={() => setActiveHallId(hall.id)}
                    className={`px-3 py-1 rounded-lg text-xs font-medium border transition-all ${
                      activeHallId === hall.id ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-white/5 text-gray-400 border-transparent hover:bg-white/10'
                    }`}
                  >
                    {hall.name}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2 max-h-[120px] overflow-y-auto pl-1">
                {tables
                  .filter((t) => t.hallId === activeHallId)
                  .sort((a, b) => { const isEleven = (name: string) => /(?:table|تيبول|ترابيزة|طاولة)\s*11$/i.test(name.trim()); return Number(isEleven(a.name)) - Number(isEleven(b.name)) || a.name.localeCompare(b.name, undefined, { numeric: true }); })
                  .map((table) => (
                    <button
                      key={table.id}
                      onClick={() => { if (!ensureActiveShift()) return; if (useAppStore.getState().activeTableId !== table.id) { setCart(null); setActiveTableId(table.id); } }}
                      className={`flex flex-col items-center justify-center p-2 rounded-lg text-xs font-medium border transition-all h-[52px] ${
                        activeTableId === table.id
                          ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40 shadow-md'
                          : table.status === 'OCCUPIED'
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
                          : 'bg-white/5 text-gray-300 border-white/5 hover:bg-white/10'
                      }`}
                    >
                      <span>{table.name}</span>
                      <span className="text-[9px] opacity-75">{table.status === 'OCCUPIED' ? 'مشغولة' : 'فاضية'}</span>
                    </button>
                  ))}
              </div>
            </div>

            {/* Menu Items Grid */}
            <div className="flex-1 glass-panel rounded-xl p-4 flex flex-col gap-4 overflow-hidden">
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2 border-b border-white/5 pb-3 max-h-44 overflow-y-auto shrink-0">
                {loadingPOS && categories.length === 0 ? (
                  <div className="flex items-center gap-2 py-1 px-3 text-xs text-cyan-300/80 animate-pulse">
                    <Database className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                    <span>جاري تحميل الأقسام...</span>
                  </div>
                ) : (
                  categories.map((cat) => (
                    <button
                      key={cat.id}
                      draggable
                      onDragStart={() => { draggedCategory.current = cat.id; }}
                      onDragOver={event => event.preventDefault()}
                      onDrop={event => { event.preventDefault(); const from = categories.findIndex(c => c.id === draggedCategory.current); const to = categories.findIndex(c => c.id === cat.id); if (from < 0 || to < 0 || from === to) return; const ordered = [...categories]; const [moved] = ordered.splice(from, 1); ordered.splice(to, 0, moved); setCategories(ordered); localStorage.setItem('bon_category_order', JSON.stringify(ordered.map(c => c.id))); draggedCategory.current = null; }}
                      onClick={() => { setSelectedCategoryId(cat.id); setMenuSearch(''); }}
                      className={`px-4 py-2 rounded-xl text-xs font-semibold border whitespace-nowrap transition-all ${
                        selectedCategoryId === cat.id ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-white/5 text-gray-400 border-transparent hover:bg-white/10'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))
                )}
              </div>

              <div className="text-xs text-amber-300">{items.filter(item => item.stock && (item.stock.quantity <= 0 || item.stock.quantity < item.stock.minimum)).length > 0 && `تنبيه: ${items.filter(item => item.stock && (item.stock.quantity <= 0 || item.stock.quantity < item.stock.minimum)).length} أصناف تحت حد النواقص عند آخر تحديث`}</div>
              <div className="flex items-center gap-3"><input aria-label="بحث في القسم" value={menuSearch} onChange={event => setMenuSearch(event.target.value)} placeholder="ابحث عن صنف في القسم" className="flex-1 rounded-lg bg-slate-950 border border-white/10 px-3 py-2 text-sm" /><span className="text-xs text-gray-300">عدد الأصناف: {items.length}</span></div>
              <div className="flex-1 overflow-y-auto pl-1">
                {loadingPOS && items.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <NeonSpinner label="جاري تحميل منيو BON el MOON..." subLabel="لحظات وتصبح قائمة المشروبات والمأكولات جاهزة" />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
                    {items
                      .filter((i) => i.categoryId === selectedCategoryId && i.name.toLocaleLowerCase('ar').includes(menuSearch.trim().toLocaleLowerCase('ar')))
                      .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
                      .map((item) => (
                        <div key={item.id} className="flex flex-col gap-1">
                        <button
                          onClick={() => handleItemClick(item)}
                          className="glass-panel-hover flex flex-col justify-between p-3.5 rounded-xl text-right bg-slate-900/40 border border-white/5 h-[95px] cursor-pointer hover:border-cyan-500/30"
                        >
                          <span className="font-semibold text-xs text-white line-clamp-2">{item.name}</span>
                          {item.stock && <span className={`text-[10px] ${(item.stock.quantity <= 0 || item.stock.quantity < item.stock.minimum) ? "text-rose-400" : "text-gray-400"}`}>الرصيد عند آخر تحديث: {item.stock.quantity} {({ unit: "قطعة", kg: "كجم", g: "جرام" } as Record<string, string>)[item.stock.unit] || item.stock.unit}</span>}
                          <div className="flex items-center justify-between w-full mt-2 flex-row-reverse">
                            <span className="text-cyan-400 font-bold text-xs">EGP {item.price.toFixed(2)}</span>
                            <PlusCircle className="w-4 h-4 text-cyan-400/80" />
                          </div>
                        </button>
                        <button type="button" onClick={(event) => handleOpenModifiers(event, item)} className="text-xs rounded-lg border border-white/10 p-1.5 text-cyan-300 hover:bg-white/10">إضافات وملاحظة</button>
                        </div>
                      ))}
                    {!loadingPOS && items.filter((i) => i.categoryId === selectedCategoryId && i.name.toLocaleLowerCase('ar').includes(menuSearch.trim().toLocaleLowerCase('ar'))).length === 0 && (
                      <div className="col-span-full py-16 text-center text-gray-500 text-xs">
                        لا توجد أصناف في هذا القسم حالياً
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Right Side: Active Cart & Multi-Payment Checkout Panel */}
          <section className={`w-full lg:w-[400px] xl:w-[440px] bg-[#1c140f] lg:border-r border-white/5 flex flex-col overflow-hidden shrink-0 ${mobileTab === 'cart' ? 'flex' : 'hidden lg:flex'}`}>
            <div className="p-3.5 border-b border-white/5 flex items-center justify-between shrink-0 flex-row-reverse">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-purple-400" />
                <h3 className="font-semibold text-xs text-white">
                  {cart?.orderType === 'DINE_IN' ? `فاتورة ${cart.tableName}` : 'فاتورة التيك أواي'}
                </h3>
              </div>
              <button 
                onClick={handleClearCart}
                disabled={!cart || cart.items.length === 0}
                className="text-xs text-gray-400 hover:text-rose-400 disabled:opacity-50 transition-all flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>مسح الكل</span>
              </button>
            </div>

            {/* Customer Picker & Auto Discount */}
            {/* 1. Customer Selector Top Bar */}
            {selectedCustomerId ? (
              <div className="p-2.5 border-b border-white/5 bg-gradient-to-r from-purple-950/40 to-cyan-950/40 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300 text-xs shrink-0">
                    👤
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-bold text-white block leading-tight">
                      {customers.find(c => c.id === selectedCustomerId)?.name}
                    </span>
                    <span className="text-[10px] text-purple-300">
                      فئة {getCustomerTypeLabel(customers.find(c => c.id === selectedCustomerId)?.type || '')} | خصم {customers.find(c => c.id === selectedCustomerId)?.discountRate}% مطبق ✓
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleSelectCustomer('')}
                  className="px-2 py-1 bg-white/5 hover:bg-rose-500/20 text-gray-400 hover:text-rose-300 border border-white/5 rounded-lg text-[10px] transition-all shrink-0"
                  title="إلغاء اختيار العميل"
                >
                  ✕ إلغاء
                </button>
              </div>
            ) : (
              <div className="p-3 border-b border-white/5 bg-slate-900/40 flex items-center gap-2">
                <div className="flex-1">
                  <select
                    value={selectedCustomerId}
                    onChange={(e) => handleSelectCustomer(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 text-right"
                  >
                    <option value="">👤 اختيار عميل مسجل (خصم تلقائي)...</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({getCustomerTypeLabel(c.type)} - خصم {c.discountRate}%)
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddCustomerModal(true)}
                  className="p-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded-lg transition-all"
                  title="إضافة عميل جديد"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Cart Items List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              {cart && cart.items.length > 0 ? (
                cart.items.map((item) => (
                  <div key={item.id} className="p-2.5 bg-slate-900/60 border border-white/5 rounded-xl flex flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-2 flex-row-reverse text-right">
                      <div>
                        <h4 className="font-medium text-xs text-white leading-tight">{item.name}</h4>
                        {item.modifiers.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1 justify-start">
                            {item.modifiers.map((m, idx) => (
                              <span key={idx} className="text-[9px] px-1 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/15">
                                +{m.name}
                              </span>
                            ))}
                          </div>
                        )}
                        {item.comment && <p className="text-[10px] text-amber-300 mt-0.5">{item.comment}</p>}
                      </div>
                      <span className="font-bold text-xs text-cyan-400 shrink-0">
                        EGP {item.totalPrice.toFixed(2)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between border-t border-white/5 pt-1.5 flex-row-reverse">
                      <span className="text-[10px] text-gray-400">EGP {item.unitPrice.toFixed(2)} / {items.find(product => product.id === item.itemId)?.stock?.unit === 'kg' ? 'كجم' : items.find(product => product.id === item.itemId)?.stock?.unit === 'g' ? 'جرام' : 'واحد'}</span>
                      <div className="flex items-center gap-2 flex-row-reverse">
                        <button onClick={() => handleUpdateQty(item.id, 1)} className="p-1 rounded bg-white/5 hover:bg-white/10 text-gray-300"><Plus className="w-3 h-3" /></button>
                        <span className="text-xs font-bold text-white w-4 text-center">{item.qty}</span>
                        <button onClick={() => handleUpdateQty(item.id, -1)} className="p-1 rounded bg-white/5 hover:bg-white/10 text-gray-300"><Minus className="w-3 h-3" /></button>
                        <button onClick={() => handleRemoveItem(item.id)} className="mr-1 text-gray-500 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 gap-2 mt-12">
                  <Coffee className="w-10 h-10 stroke-1 opacity-40 animate-float" />
                  <p className="text-xs">الفاتورة فاضية حالياً</p>
                </div>
              )}
            </div>

            {/* Pricing, Discounts & Payment Selection Section */}
            <div className="p-3.5 border-t border-white/5 bg-[#0c0907] shrink-0 space-y-3">
              {/* Discount selection */}
              {selectedCustomerId ? (
                <div className="p-2.5 bg-purple-500/10 border border-purple-500/20 rounded-xl flex items-center justify-between text-xs flex-row-reverse">
                  <span className="font-mono font-bold text-purple-300">
                    {cart?.discountRate || 0}% (EGP {cart?.discount.toFixed(2) || '0.00'})
                  </span>
                  <span className="text-purple-200 font-medium">🏷️ خصم عميل معتمد مطبق</span>
                </div>
              ) : (
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-4">
                    <input
                      type="number"
                      value={discountVal}
                      onChange={(e) => handleDiscountChange(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-500 text-right focus:border-cyan-500 focus:outline-none font-mono"
                      placeholder="خصم %"
                      min="0"
                      max="100"
                    />
                  </div>
                  <div className="col-span-8">
                    <select
                      value={discountReason}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDiscountReason(val);
                        if (!val) {
                          handleDiscountChange('0');
                          return;
                        }
                        const foundReason = discountReasons.find((r) => r.reason === val);
                        if (foundReason && foundReason.rate !== null && foundReason.rate !== undefined) {
                          handleDiscountChange(String(foundReason.rate));
                        }
                      }}
                      className="w-full bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 text-right"
                    >
                      <option value="">سبب الخصم الثابت...</option>
                      {discountReasons.map((dr) => (
                        <option key={dr.id} value={dr.reason}>
                          {dr.reason} {dr.rate ? `(${dr.rate}%)` : ''}
                        </option>
                      ))}
                      <option value="خصم مباشر">خصم مباشر</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Price Calculations */}
              <div className="space-y-1 border-b border-white/5 pb-2.5">
                <div className="flex justify-between text-xs text-gray-400 flex-row-reverse">
                  <span>الإجمالي قبل الخصم</span>
                  <span>EGP {cart?.subtotal.toFixed(2) || '0.00'}</span>
                </div>
                {cart && cart.discount > 0 && (
                  <div className="flex justify-between text-xs text-rose-400 flex-row-reverse">
                    <span>الخصم ({cart.discountRate || 0}%) {discountReason ? `- ${discountReason}` : ''}</span>
                    <span>-EGP {cart.discount.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm font-bold text-white pt-1 flex-row-reverse">
                  <span>المطلوب دفعه</span>
                  <span className="text-cyan-400 text-base">EGP {payableAmount.toFixed(2)}</span>
                </div>
              </div>

              {/* Payment Methods Grid */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold tracking-wider text-gray-400 block text-right">
                  طريقة الدفع (المحددة تظهر بالفاتورة)
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('CASH')}
                    className={`flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                      paymentMethod === 'CASH'
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                        : 'bg-slate-900 border-white/5 text-gray-400 hover:text-white'
                    }`}
                  >
                    <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                    <span>نقدي (كاش)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaymentMethod('VISA')}
                    className={`flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                      paymentMethod === 'VISA'
                        ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                        : 'bg-slate-900 border-white/5 text-gray-400 hover:text-white'
                    }`}
                  >
                    <CreditCard className="w-3.5 h-3.5 text-blue-400" />
                    <span>فيزا (Visa)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaymentMethod('INSTAPAY')}
                    className={`flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                      paymentMethod === 'INSTAPAY'
                        ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                        : 'bg-slate-900 border-white/5 text-gray-400 hover:text-white'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" />
                    <span>إنستا باي</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaymentMethod('VODAFONE_CASH')}
                    className={`flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg border text-[11px] font-semibold transition-all col-span-1.5 ${
                      paymentMethod === 'VODAFONE_CASH'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                        : 'bg-slate-900 border-white/5 text-gray-400 hover:text-white'
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5 text-rose-400" />
                    <span>فودافون كاش</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (cart?.items.length) { triggerAlert('error', 'الكاش آوت عملية منفصلة؛ أفرغ السلة أولاً'); return; }
                      setPaymentMethod('CASH_OUT');
                    }}
                    className={`flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg border text-[11px] font-semibold transition-all col-span-2 ${
                      paymentMethod === 'CASH_OUT'
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-slate-900 border-white/5 text-gray-400 hover:text-white'
                    }`}
                  >
                    <Wallet className="w-3.5 h-3.5 text-amber-400" />
                    <span>سحب كاش بالفيزا (Cashout)</span>
                  </button>
                </div>

                {paymentMethod === 'CASH_OUT' && (
                  <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg space-y-2">
                    <p className="text-[11px] text-amber-300">سحب نقدية وإعطاء العميل كاش مقابل السحب بالفيزا</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-gray-400 block">المبلغ المطلوب سحبه كاش</label>
                        <input
                          type="number"
                          value={cashOutAmount}
                          onChange={(e) => setCashOutAmount(e.target.value)}
                          className="w-full bg-slate-900 border border-white/10 rounded px-2 py-1 text-xs text-white text-right"
                          placeholder="مثال: 500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400 block">رسوم / عمولة السحب</label>
                        <input
                          type="number"
                          value={cashOutFee}
                          onChange={(e) => setCashOutFee(e.target.value)}
                          className="w-full bg-slate-900 border border-white/10 rounded px-2 py-1 text-xs text-white text-right"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Complete checkout button */}
              <button
                onClick={() => setShowPaymentConfirm(true)}
                disabled={!cart || (paymentMethod === 'CASH_OUT' ? (!cashOutValid || cart.items.length > 0) : cart.items.length === 0)}
                className="w-full py-3 bg-gradient-to-r from-cyan-500 to-purple-600 hover:from-cyan-600 hover:to-purple-700 text-white font-bold rounded-xl shadow-md transition-all disabled:opacity-50 text-sm flex items-center justify-center gap-2 flex-row-reverse"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{`تأكيد وتقفيل الحساب (EGP ${payableAmount.toFixed(2)})`}</span>
              </button>
            </div>
          </section>
        </main>

        {showModifiersModal && activeItemForMod && (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onClick={() => setShowModifiersModal(false)}>
            <div className="w-full max-w-md glass-panel rounded-2xl p-6 space-y-4" onClick={(event) => event.stopPropagation()}>
              <h3 className="font-bold text-white">إضافات وملاحظة: {activeItemForMod.name}</h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {modifiers.map(modifier => (
                  <label key={modifier.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={selectedMods.includes(modifier.id)} onChange={(event) => setSelectedMods(current => event.target.checked ? [...current, modifier.id] : current.filter(id => id !== modifier.id))} />
                    <span>{modifier.name} (+{modifier.priceImpact.toFixed(2)} ج)</span>
                  </label>
                ))}
              </div>
              <label className="block text-sm">ملاحظة على الصنف
                <input value={itemComment} onChange={(event) => setItemComment(event.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 p-2 text-white" />
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={confirmModifiers} className="flex-1 rounded-lg bg-cyan-600 p-2 font-bold text-white">إضافة للسلة</button>
                <button type="button" onClick={() => setShowModifiersModal(false)} className="rounded-lg bg-white/10 p-2">إلغاء</button>
              </div>
            </div>
          </div>
        )}

        {/* Quick Add Customer Modal */}
        {showAddCustomerModal && (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddCustomerModal(false)}>
            <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowAddCustomerModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
              <h3 className="text-lg font-bold text-white mb-2">إضافة عميل جديد</h3>
              <form onSubmit={handleQuickAddCustomer} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1">اسم العميل / الجهة</label>
                  <input required type="text" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right" placeholder="مثال: د. أحمد / شركة النور" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1">رقم الهاتف (اختياري)</label>
                  <input type="text" value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right" placeholder="01xxxxxxxxx" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-300 mb-1">فئة العميل</label>
                    <select value={newCustType} onChange={(e) => setNewCustType(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right">
                      <option value="INDIVIDUAL">زبون مميز</option>
                      <option value="COMPANY">شركة / مؤسسة</option>
                      <option value="HOSPITAL">مستشفى / أطباء</option>
                      <option value="CAFE">كافيه / مطعم</option>
                      <option value="OTHER">أخرى</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-300 mb-1">نسبة الخصم الثابتة (%)</label>
                    <input type="number" min="0" max="100" value={newCustDiscount} onChange={(e) => setNewCustDiscount(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right" placeholder="مثال: 15" />
                  </div>
                </div>
                <button type="submit" disabled={savingCustomer} className="w-full py-2.5 mt-2 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs">
                  {savingCustomer ? 'جاري الحفظ...' : 'حفظ وتطبيق الخصم'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Returns / Refund Modal */}
        {showReturnModal && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowReturnModal(false)}>
            <div className="w-full max-w-2xl glass-panel rounded-2xl p-6 relative text-right max-h-[85vh] overflow-y-auto" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowReturnModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
              <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-rose-400" />
                <span>إرجاع فاتورة / مرتجع مبيعات</span>
              </h3>
              <p className="text-xs text-gray-400 mb-4">اختر الفاتورة المراد إرجاعها أو ابحث برقم الإيصال</p>

              {!selectedReturnOrder ? (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="w-4 h-4 text-gray-400 absolute right-3 top-2.5" />
                    <input
                      type="text"
                      value={returnSearchQuery}
                      onChange={(e) => setReturnSearchQuery(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-xl pr-9 pl-4 py-2 text-xs text-white text-right"
                      placeholder="ابحث برقم الإيصال (مثال: BON-...)..."
                    />
                  </div>

                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {recentCompletedOrders
                      .filter((o) => !returnSearchQuery || o.receiptNumber?.includes(returnSearchQuery))
                      .map((ord) => (
                        <div
                          key={ord.id}
                          onClick={() => setSelectedReturnOrder(ord)}
                          className="p-3 bg-slate-900/60 hover:bg-white/5 border border-white/5 rounded-xl flex items-center justify-between cursor-pointer transition-all flex-row-reverse"
                        >
                          <div className="text-right">
                            <span className="font-bold text-xs text-white">{ord.receiptNumber}</span>
                            <span className="text-[10px] text-gray-400 block">{new Date(ord.createdAt).toLocaleTimeString()} - {getPaymentMethodArabic(ord.paymentMethod)}</span>
                          </div>
                          <span className="text-cyan-400 font-bold text-xs">EGP {ord.total.toFixed(2)}</span>
                        </div>
                      ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-3 bg-white/5 border border-white/10 rounded-xl flex justify-between items-center flex-row-reverse">
                    <div>
                      <span className="font-bold text-sm text-white">إيصال: {selectedReturnOrder.receiptNumber}</span>
                      <span className="text-xs text-gray-400 block">الإجمالي: EGP {selectedReturnOrder.total.toFixed(2)}</span>
                    </div>
                    <button onClick={() => setSelectedReturnOrder(null)} className="text-xs text-cyan-400 underline">تغيير الفاتورة</button>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-300 mb-1">سبب الإرجاع</label>
                    <select value={returnReason} onChange={(e) => setReturnReason(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right">
                      <option value="طلب العميل">طلب العميل</option>
                      <option value="خطأ في الطلب">خطأ في الطلب</option>
                      <option value="جودة المنتج">ملاحظة على جودة المنتج</option>
                      <option value="تأخر الطلب">تأخر في التقديم</option>
                      <option value="أخرى">أسباب أخرى</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="restock" checked={returnRestock} onChange={(e) => setReturnRestock(e.target.checked)} className="rounded" />
                    <label htmlFor="restock" className="text-xs text-gray-300">إعادة الخامات والمكونات للمخزن</label>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <button onClick={() => setSelectedReturnOrder(null)} className="py-2.5 border border-white/10 text-white rounded-xl text-xs">إلغاء</button>
                    <button disabled={submittingReturn} onClick={handleProcessReturn} className="py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs">
                      {submittingReturn ? 'جاري الإرجاع...' : `تأكيد استرجاع EGP ${selectedReturnOrder.total.toFixed(2)}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Payment Confirm Modal */}
        {showPaymentConfirm && cart && (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowPaymentConfirm(false)}>
            <div className="w-full max-w-sm glass-panel rounded-2xl p-6 text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white">تأكيد الدفع وتقفيل الفاتورة</h3>
              <div className="my-4 p-3.5 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex justify-between text-xs text-gray-300 flex-row-reverse">
                  <span>المبلغ المطلوب</span>
                  <span className="font-bold text-cyan-400 text-sm">EGP {payableAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-xs text-gray-300 flex-row-reverse">
                  <span>طريقة الدفع</span>
                  <span className="font-bold text-white">{getPaymentMethodArabic(paymentMethod)}</span>
                </div>
                {selectedCustomerId && (
                  <div className="flex justify-between text-xs text-gray-300 flex-row-reverse">
                    <span>العميل</span>
                    <span className="font-semibold text-purple-300">{customers.find(c => c.id === selectedCustomerId)?.name}</span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => setShowPaymentConfirm(false)} className="py-2.5 border border-white/10 text-white rounded-xl text-xs">رجوع</button>
                <button type="button" onClick={() => { setShowPaymentConfirm(false); handleCompleteOrder(); }} className="py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs">
                  تأكيد وطباعة
                </button>
              </div>
            </div>
          </div>
        )}

        {/* RECEIPT PRINTING PREVIEW MODAL */}
        {showPrintModal && receiptOrder && (
          <div className="fixed inset-0 z-45 bg-black/85 flex items-center justify-center p-4 backdrop-blur-sm no-print" onClick={() => { setShowPrintModal(false); setReceiptOrder(null); }}>
            <div className="w-full max-w-sm glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setShowPrintModal(false); setReceiptOrder(null); }} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
              <h3 className="text-base font-bold text-white mb-2 flex items-center gap-2 flex-row-reverse">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span>تم الدفع ومعاينة الفاتورة</span>
              </h3>
              
              <div className="p-3 bg-white text-black font-mono rounded-lg shadow-inner max-h-[350px] overflow-y-auto">
                {ReceiptLayout({ preview: true })}
                {receiptOrder.paymentMethod !== 'CASH_OUT' && <>
                  <div className="kot-divider text-gray-500 my-3 border-t-2 border-dashed border-gray-400 pt-2 text-[10px] text-center font-bold">- - - بون البار / المطبخ - - -</div>
                  {BaristaKotLayout({ preview: true })}
                </>}
              </div>

              <p className="mt-3 text-xs text-amber-300">في نافذة الطباعة اختَر XP-80C من خانة الطابعة أو الوجهة بدل «حفظ كملف PDF». تقدر تعيد المحاولة من هنا.</p>
              <div className="grid grid-cols-2 gap-3 mt-4">
                <button onClick={() => { setShowPrintModal(false); setReceiptOrder(null); }} className="py-2.5 border border-white/10 text-white rounded-xl text-xs">قفل</button>
                <button onClick={() => window.print()} className="py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1">
                  <Printer className="w-4 h-4" />
                  <span>طباعة مجدداً</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* OPEN SHIFT DIALOG */}
        {showOpenShift && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm no-print" onClick={() => setShowOpenShift(false)}>
            <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowOpenShift(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              <h3 className="text-xl font-bold text-white mb-1 flex items-center gap-2">
                <Coffee className="w-5 h-5 text-amber-400" />
                <span>فتح وردية جديدة</span>
              </h3>
              <p className="text-xs text-gray-400 mb-4">أدخل اسم الكاشير ومبلغ العهدة / الفكة الافتتاحية في الدرج لبدء البيع</p>

              <form onSubmit={handleOpenShiftSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1">اسم الكاشير المسؤول *</label>
                  <input
                    required
                    type="text"
                    value={cashierName}
                    onChange={(e) => setCashierName(e.target.value)}
                    placeholder={user?.name || "اكتب اسم الكاشير"}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl py-2.5 px-3 text-white text-xs text-right placeholder-gray-500 focus:border-cyan-500"
                  />

                  {/* Quick Select Saved Cashier Names */}
                  {savedCashierNames.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="text-[10px] text-gray-400 w-full">أسماء سريعة:</span>
                      {savedCashierNames.map((cn) => (
                        <button
                          key={cn.id}
                          type="button"
                          onClick={() => setCashierName(cn.name)}
                          className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-cyan-500/20 text-gray-300 hover:text-cyan-300 border border-white/10 text-xs transition-all active:scale-95"
                        >
                          {cn.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1">مبلغ العهدة الافتتاحي في الدرج (Float Cash)</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={floatCash}
                    onChange={(e) => setFloatCash(e.target.value)}
                    placeholder="0.00 (الفكة في الدرج)"
                    className="w-full bg-slate-900 border border-white/10 rounded-xl py-2.5 px-3 text-white text-xs text-right placeholder-gray-500 focus:border-cyan-500 font-mono"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowOpenShift(false)}
                    className="py-2.5 border border-white/10 text-white rounded-xl text-xs hover:bg-white/5"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    className="py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-500/20"
                  >
                    بدء الوردية والبيع
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* EXPENSE MODAL */}
        {showExpenseModal && (
          <div className="fixed inset-0 z-40 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm no-print" onClick={() => setShowExpenseModal(false)}>
            <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowExpenseModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2.5 mb-1">
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-400 border border-amber-500/20 shadow-sm">
                  <DollarSign className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">تسجيل مصروف من الدرج (نثريات)</h3>
                  <p className="text-[11px] text-gray-400">يُخصم تلقائياً من الكاش المتوقع بالدرج في الوردية الحالية.</p>
                </div>
              </div>

              <form onSubmit={handleExpenseSubmit} className="space-y-4 mt-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5">مبلغ المصروف (ج.م) *</label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    required
                    autoFocus
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl py-2.5 px-3 text-white text-base text-right font-mono focus:border-amber-500 placeholder-gray-600"
                    placeholder="0.00"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5">سبب / بيان المصروف *</label>
                  <input
                    type="text"
                    required
                    value={expenseReason}
                    onChange={(e) => setExpenseReason(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl py-2.5 px-3 text-white text-xs text-right focus:border-amber-500 placeholder-gray-600"
                    placeholder="مثال: شراء ليمون، أدوات نظافة، صيانة..."
                  />
                  {/* Quick suggestion tags */}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {['شراء خامات طارئة', 'أدوات نظافة', 'صيانة سريعة', 'ضيافة وبوفيه', 'إكراميات ونثريات'].map((tag) => (
                      <button
                        type="button"
                        key={tag}
                        onClick={() => setExpenseReason(tag)}
                        className="text-[10px] bg-white/5 hover:bg-amber-500/20 text-gray-300 hover:text-amber-300 border border-white/10 px-2 py-0.5 rounded-md transition-all"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowExpenseModal(false)}
                    className="py-2.5 border border-white/10 text-white rounded-xl text-xs hover:bg-white/5 transition-all"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    className="py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-500/20 transition-all"
                  >
                    تأكيد تسجيل المصروف
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* CLOSE SHIFT DIALOG */}
        {showCloseShift && (
          <div className="fixed inset-0 z-40 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm no-print" onClick={() => setShowCloseShift(false)}>
            <div className="w-full max-w-lg glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowCloseShift(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
              <h3 className="text-xl font-bold text-white mb-1">تسوية وإغلاق الوردية</h3>
              <p className="text-xs text-gray-400 mb-4">اكتب المبالغ الفعلية لمطابقة الحسابات ومقارنتها بالمتوقع.</p>

              {/* Expected Totals Card */}
              <div className="bg-slate-900/80 border border-white/10 rounded-xl p-3.5 mb-4">
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-xs font-bold text-gray-200">المبالغ المتوقعة المسجلة بالسيستم:</span>
                  <button
                    type="button"
                    onClick={handleAutoFillExpected}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 px-2.5 py-1 rounded-lg font-semibold transition-all"
                  >
                    ملء المتوقع تلقائياً
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2">
                    <span className="block text-[10px] text-emerald-300 mb-0.5">الكاش المتوقع بالدرج</span>
                    <strong className="text-emerald-400 text-sm font-bold font-mono">{(activeShift?.expectedCash || 0).toFixed(2)} ج</strong>
                  </div>
                  <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-2">
                    <span className="block text-[10px] text-cyan-300 mb-0.5">إنستا باي المتوقع</span>
                    <strong className="text-cyan-400 text-sm font-bold font-mono">{(activeShift?.expectedInstaPay || 0).toFixed(2)} ج</strong>
                  </div>
                  <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-2">
                    <span className="block text-[10px] text-purple-300 mb-0.5">الفيزا المتوقعة</span>
                    <strong className="text-purple-400 text-sm font-bold font-mono">{(activeShift?.expectedVisa || 0).toFixed(2)} ج</strong>
                  </div>
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
                    <span className="block text-[10px] text-amber-300 mb-0.5">فودافون كاش</span>
                    <strong className="text-amber-400 text-sm font-bold font-mono">{(activeShift?.expectedVodafoneCash || 0).toFixed(2)} ج</strong>
                  </div>
                </div>
              </div>

              <form onSubmit={handleCloseShiftSubmit} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-gray-300">الكاش الفعلي في الدرج</label>
                      <span className="text-[10px] text-emerald-400 font-mono font-semibold">{(activeShift?.expectedCash || 0).toFixed(0)} ج</span>
                    </div>
                    <input type="number" step="any" required value={closedCash} onChange={(e) => setClosedCash(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right font-mono" placeholder="0.00" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-gray-300">الفيزا الفعلية</label>
                      <span className="text-[10px] text-purple-400 font-mono font-semibold">{(activeShift?.expectedVisa || 0).toFixed(0)} ج</span>
                    </div>
                    <input type="number" step="any" value={closedVisa} onChange={(e) => setClosedVisa(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right font-mono" placeholder="0.00" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-gray-300">إنستا باي الفعلي</label>
                      <span className="text-[10px] text-cyan-400 font-mono font-semibold">{(activeShift?.expectedInstaPay || 0).toFixed(0)} ج</span>
                    </div>
                    <input type="number" step="any" value={closedInstaPay} onChange={(e) => setClosedInstaPay(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right font-mono" placeholder="0.00" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-gray-300">فودافون كاش الفعلي</label>
                      <span className="text-[10px] text-amber-400 font-mono font-semibold">{(activeShift?.expectedVodafoneCash || 0).toFixed(0)} ج</span>
                    </div>
                    <input type="number" step="any" value={closedVodafoneCash} onChange={(e) => setClosedVodafoneCash(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-white text-xs text-right font-mono" placeholder="0.00" />
                  </div>
                </div>

                <button type="submit" className="w-full py-3 mt-3 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white font-bold rounded-xl text-xs shadow-lg shadow-rose-500/20 transition-all">
                  تأكيد تسوية وإغلاق الوردية
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Alert Banner */}
        {alertMsg && (
          <div dir="rtl" className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl p-4 rounded-xl shadow-2xl border text-sm flex items-start gap-3 transition-all no-print flex-row-reverse ${
            alertMsg.type === 'success' ? 'bg-emerald-950 border-emerald-400/40 text-emerald-100' : 'bg-rose-950 border-rose-400/40 text-rose-100'
          }`}>
            {alertMsg.type === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertCircle className="w-5 h-5 shrink-0" />}
            <span className="whitespace-pre-line font-semibold leading-relaxed text-right flex-1">{alertMsg.text}</span>
          </div>
        )}
      </div>

      {uncertainOrder && <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-6 no-print"><div className="max-w-md bg-slate-900 rounded-xl p-6 space-y-4 text-right" dir="rtl"><p className="text-amber-300">{verificationMessage}</p><button type="button" disabled={confirmingOrder} onClick={() => void handleCompleteOrder()} className="rounded-lg bg-cyan-700 px-4 py-2 text-white">{confirmingOrder ? 'جاري التحقق...' : 'التحقق وإعادة المحاولة'}</button></div></div>}
      {/* Thermal receipt print-only view */}
      {receiptOrder && (
        <div className="hidden print:block print-area font-mono text-black bg-white" dir="rtl">
          {ReceiptLayout({})}
          {receiptOrder.paymentMethod !== 'CASH_OUT' && <>
            <div className="kot-page-break"></div>
            {BaristaKotLayout({})}
          </>}
        </div>
      )}
    </>
  );
}
