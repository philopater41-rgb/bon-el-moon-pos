'use client';

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { addCalendarDays, cairoDateKey } from '@/lib/cairo-date';
import type { Supplier, Customer, DiscountReason, RawMaterial, PurchaseInvoice, PurchaseInvoiceItem, WastageLog } from '@prisma/client';
import { useAppStore } from '@/lib/store';
import { 
  TrendingUp, Package, AlertTriangle, Users, LogOut, 
  Trash2, DollarSign, CheckCircle2, RefreshCw, 
  Calendar, PlusCircle, ShoppingBag, X, Pencil,
  CreditCard, RotateCcw, UserPlus, Tag, 
  FileText, Download, BarChart3, Receipt, Truck,
  Eye, Printer, Database
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

interface DetailedReport {
  summary: { totalNetRevenue: number; totalCOGS: number; overallNetProfit: number; overallMarginPct: number };
  itemsSummary: Array<{ id: string; name: string; categoryName: string; qtySold: number;
    grossRevenue: number; totalCost: number; netProfit: number; marginPct: number }>;
}
interface OrderView {
  id: string; shiftId: string; receiptNumber: string | null; createdAt: string;
  customerName: string | null; orderType: string; paymentMethod: string;
  subtotal: number; discount: number; discountReason: string | null; tax: number; total: number;
  shift: { cashierName: string | null; user: { name: string } } | null;
  customer: { name: string; phone?: string | null } | null; table: { name: string } | null;
  items: Array<{ id: string; qty: number; totalPrice: number; item: { name: string } | null;
    modifiers: Array<{ modifier: { name: string } | null }> }>;
}
interface ReturnView { id: string; orderId: string; receiptNumber: string | null; cashierName: string | null;
  createdAt: string; refundAmount: number; reason: string; restockItems: boolean; order: OrderView | null }
interface LedgerSummary {
  ordersCount: number; totalSales: number; totalDiscounts: number; totalNet: number;
  returnsAmount: number; returnsCount: number; cogs: number; netProfit: number; avgTicket: number;
  payments: Record<string, number>; date?: string; dayNameAr?: string; month?: string;
  monthNameAr?: string; activeDaysCount?: number;
}
type LedgerDay = LedgerSummary & { date: string; dayNameAr: string };
type LedgerMonth = LedgerSummary & { month: string; monthNameAr: string; activeDaysCount: number };
type SupplierSummary = Supplier & { totalPurchases: number; totalPaid: number; remainingBalance: number };
type CustomerSummary = Customer & { totalOrders: number; totalSpent: number; totalDiscountReceived: number };
type InvoiceSummary = PurchaseInvoice & { supplier: Pick<Supplier, 'name'> | null; items: PurchaseInvoiceItem[] };
type WastageSummary = WastageLog & { rawMaterial: Pick<RawMaterial, 'name' | 'deductUnit'> };
interface Expense { id: string; shiftId: string; createdAt: string; reason: string; amount: number; shift: { cashierName: string | null; user: { name: string } } }

interface TopSellingItem { name: string; qty: number; total: number }

interface KPIState {
  todaySales: number;
  monthlySales: number;
  todayOrdersCount: number;
  monthlyOrdersCount: number;
  todayAvgTicket: number;
  monthlyAvgTicket: number;
  todayDiscounts: number;
  monthlyDiscounts: number;
  todayReturnsCount: number;
  todayReturnsAmount: number;
  monthlyReturnsAmount: number;
  todayCOGS: number;
  monthlyCOGS: number;
  todayExpenses: number;
  monthlyExpenses: number;
  todayNet: number;
  monthlyNet: number;
  activeShiftUser: string;
  activeShiftExpected: number;
}

interface PaymentBreakdown {
  cash: number;
  visa: number;
  instapay: number;
  vodafoneCash: number;
  cashOut: number;
}

interface ProductCostItem {
  id: string;
  name: string;
  categoryId?: string;
  categoryName: string;
  price: number;
  cost?: number;
  unitCost: number;
  profitPerUnit: number;
  profitMarginPct: number;
  hasRecipe: boolean;
  qtySoldToday: number;
  totalRevenueToday: number;
  totalCostToday: number;
  totalProfitToday: number;
  ingredients: Array<{
    rawMaterialId?: string;
    materialName: string;
    quantity: number;
    deductUnit: string;
    cost: number;
  }>;
}

export default function AdminPage() {
  const router = useRouter();
  const { user, logout } = useAppStore();

  // Active Navigation Tab
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'invoices-ledger' | 'purchases' | 'customers' | 'returns' | 'expenses' | 'profitability' | 'inventory' | 'reports' | 'backup'
  >('dashboard');

  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [todayLabel, setTodayLabel] = useState('');
  const mounted = useSyncExternalStore(subscribeHydration, getClientSnapshot, getServerSnapshot);

  // 1. Dashboard State
  const [kpis, setKpis] = useState<KPIState>({
    todaySales: 0,
    monthlySales: 0,
    todayOrdersCount: 0,
    monthlyOrdersCount: 0,
    todayAvgTicket: 0,
    monthlyAvgTicket: 0,
    todayDiscounts: 0,
    monthlyDiscounts: 0,
    todayReturnsCount: 0,
    todayReturnsAmount: 0,
    monthlyReturnsAmount: 0,
    todayCOGS: 0,
    monthlyCOGS: 0,
    todayExpenses: 0,
    monthlyExpenses: 0,
    todayNet: 0,
    monthlyNet: 0,
    activeShiftUser: 'جاري التحميل...',
    activeShiftExpected: 0,
  });
  const [payments, setPayments] = useState<PaymentBreakdown>({ cash: 0, visa: 0, instapay: 0, vodafoneCash: 0, cashOut: 0 });
  const [topItems, setTopItems] = useState<TopSellingItem[]>([]);
  const [topItemsByPeriod, setTopItemsByPeriod] = useState<{
    today: TopSellingItem[];
    month: TopSellingItem[];
    all: TopSellingItem[];
  }>({ today: [], month: [], all: [] });
  const [topItemsPeriod, setTopItemsPeriod] = useState<'today' | 'month' | 'all'>('today');
  const [discountsBreakdown, setDiscountsBreakdown] = useState<Array<{ reason: string; count: number; totalAmount: number }>>([]);

  // 2. Purchases & Suppliers State
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<InvoiceSummary[]>([]);
  const [showAddSupplierModal, setShowAddSupplierModal] = useState(false);
  const [showAddPurchaseModal, setShowAddPurchaseModal] = useState(false);
  const [newSuppName, setNewSuppName] = useState('');
  const [newSuppPhone, setNewSuppPhone] = useState('');
  const [newSuppCompany, setNewSuppCompany] = useState('');
  const newSuppAddress = '';
  const newSuppNotes = '';
  // Purchase Form
  const [purSupplierId, setPurSupplierId] = useState('');
  const [purPaymentMethod, setPurPaymentMethod] = useState('CASH');
  const [purPaidAmount, setPurPaidAmount] = useState('');
  const [purItems, setPurItems] = useState<Array<{ rawMaterialId: string; itemName: string; quantity: string; purchaseUnit: string; totalPrice: string }>>([
    { rawMaterialId: '', itemName: '', quantity: '', purchaseUnit: 'kg', totalPrice: '' },
  ]);
  // Settle Payment State
  const [showPayModal, setShowPayModal] = useState(false);
  const [selectedInvoiceToPay, setSelectedInvoiceToPay] = useState<InvoiceSummary | null>(null);
  const [paymentAmountInput, setPaymentAmountInput] = useState('');
  const [paymentMethodInput, setPaymentMethodInput] = useState('CASH');
  const [paymentNotesInput, setPaymentNotesInput] = useState('');

  // 3. Customers & Discounts State
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [discountReasons, setDiscountReasons] = useState<DiscountReason[]>([]);
  const [showAddCustModal, setShowAddCustModal] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustType, setNewCustType] = useState('INDIVIDUAL');
  const [newCustDiscount, setNewCustDiscount] = useState('0');
  const newCustNotes = '';
  const [newReasonText, setNewReasonText] = useState('');
  const [newReasonRate, setNewReasonRate] = useState('');

  // 4. Returns Log State
  const [returnsLog, setReturnsLog] = useState<ReturnView[]>([]);

  // 5. Product Costs & Profitability State
  const [productCosts, setProductCosts] = useState<ProductCostItem[]>([]);
  const [totalTodayProfit, setTotalTodayProfit] = useState(0);
  // Add Menu Item State
  const [showAddItemModal, setShowAddItemModal] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('');
  const [newItemCost, setNewItemCost] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemMargin, setNewItemMargin] = useState('');
  const [showNewItemRecipeSection, setShowNewItemRecipeSection] = useState(false);
  const [newItemIngredients, setNewItemIngredients] = useState<
    Array<{ rawMaterialId: string; quantity: string; customUnitCost?: string }>
  >([]);
  // Edit Menu Item State
  const [showEditItemModal, setShowEditItemModal] = useState(false);
  const [selectedItemToEdit, setSelectedItemToEdit] = useState<ProductCostItem | null>(null);
  const [editItemId, setEditItemId] = useState('');
  const [editItemName, setEditItemName] = useState('');
  const [editItemCategory, setEditItemCategory] = useState('');
  const [editItemCost, setEditItemCost] = useState('');
  const [editItemPrice, setEditItemPrice] = useState('');
  const [editItemMargin, setEditItemMargin] = useState('');
  const [showEditItemRecipeSection, setShowEditItemRecipeSection] = useState(false);
  const [editItemIngredients, setEditItemIngredients] = useState<
    Array<{ rawMaterialId: string; quantity: string; customUnitCost?: string }>
  >([]);

  // 6. Inventory & Wastage State
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [wastageLogs, setWastageLogs] = useState<WastageSummary[]>([]);
  const [showAddWastageModal, setShowAddWastageModal] = useState(false);
  const [wastageMatId, setWastageMatId] = useState('');
  const [wastageQty, setWastageQty] = useState('');
  const [wastageReason, setWastageReason] = useState('هدر تحضير');
  // Add Raw Material State
  const [showAddMaterialModal, setShowAddMaterialModal] = useState(false);
  const [newMatName, setNewMatName] = useState('');
  const [newMatPurchaseUnit, setNewMatPurchaseUnit] = useState('kg');
  const [newMatDeductUnit, setNewMatDeductUnit] = useState('g');
  const [newMatConversion, setNewMatConversion] = useState('1000');
  const [newMatStockQty, setNewMatStockQty] = useState('');
  const [newMatMinStock, setNewMatMinStock] = useState('');
  const [newMatCost, setNewMatCost] = useState('');
  // Edit Raw Material State
  const [showEditMaterialModal, setShowEditMaterialModal] = useState(false);
  const [selectedMaterialToEdit, setSelectedMaterialToEdit] = useState<RawMaterial | null>(null);
  const [editMatName, setEditMatName] = useState('');
  const [editMatPurchaseUnit, setEditMatPurchaseUnit] = useState('kg');
  const [editMatDeductUnit, setEditMatDeductUnit] = useState('g');
  const [editMatConversion, setEditMatConversion] = useState('1000');
  const [editMatStockQty, setEditMatStockQty] = useState('');
  const [editMatMinStock, setEditMatMinStock] = useState('');
  const [editMatCost, setEditMatCost] = useState('');

  // 7. Custom Detailed Reports State
  const [reportStartDate, setReportStartDate] = useState(() => addCalendarDays(cairoDateKey(new Date()), -30));
  const [reportEndDate, setReportEndDate] = useState(() => cairoDateKey(new Date()));
  const [reportSearchItem, setReportSearchItem] = useState('');
  const [reportPaymentMethod, setReportPaymentMethod] = useState('ALL');
  const [detailedReport, setDetailedReport] = useState<DetailedReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  // 6. Expenses State
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expensesTodayTotal, setExpensesTodayTotal] = useState(0);
  const [expensesGrandTotal, setExpensesGrandTotal] = useState(0);
  const [loadingExpenses, setLoadingExpenses] = useState(false);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [loadingPurchases, setLoadingPurchases] = useState(false);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [loadingCosts, setLoadingCosts] = useState(false);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [expenseSearchQuery, setExpenseSearchQuery] = useState('');
  const [showAddAdminExpenseModal, setShowAddAdminExpenseModal] = useState(false);
  const [adminExpenseAmount, setAdminExpenseAmount] = useState('');
  const [adminExpenseReason, setAdminExpenseReason] = useState('');
  const [submittingAdminExpense, setSubmittingAdminExpense] = useState(false);

  // 8. Sales Ledger (Daily & Monthly) State
  const [ledgerData, setLedgerData] = useState<{
    todaySummary?: LedgerDay | null;
    monthSummary?: LedgerMonth | null;
    grandTotals: LedgerSummary & { daysCount: number; monthsCount: number };
    days: LedgerDay[];
    months: LedgerMonth[];
  }>({
    todaySummary: null,
    monthSummary: null,
    grandTotals: { ordersCount: 0, totalSales: 0, totalDiscounts: 0, totalNet: 0, returnsAmount: 0, returnsCount: 0, cogs: 0, netProfit: 0, avgTicket: 0, payments: { CASH: 0, VISA: 0, INSTAPAY: 0, VODAFONE_CASH: 0, CASH_OUT: 0 }, daysCount: 0, monthsCount: 0 },
    days: [],
    months: [],
  });
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [activeLedgerView, setActiveLedgerView] = useState<'daily' | 'monthly'>('daily');
  const [ledgerSearch, setLedgerSearch] = useState('');
  
  // Drilldown for a specific day or month
  const [selectedPeriod, setSelectedPeriod] = useState<{
    type: 'day' | 'month';
    key: string;
    title: string;
  } | null>(null);
  const [periodOrders, setPeriodOrders] = useState<OrderView[]>([]);
  const [periodSummary, setPeriodSummary] = useState<Pick<LedgerSummary, 'avgTicket' | 'ordersCount' | 'totalDiscounts' | 'totalNet'> | null>(null);
  const [loadingPeriodOrders, setLoadingPeriodOrders] = useState(false);
  const [ordersSearch, setOrdersSearch] = useState('');
  const [ordersFilterPayment, setOrdersFilterPayment] = useState('ALL');

  // Selected Order for Receipt Modal
  const [selectedOrderReceipt, setSelectedOrderReceipt] = useState<OrderView | null>(null);

  useEffect(() => {
    return scheduleEffect(() => setTodayLabel(
      new Date().toLocaleDateString('ar-EG', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    ));
  }, []);

  // Guard: Admin Check
  useEffect(() => {
    if (!user) {
      router.push('/');
      return;
    }
    if (user.role !== 'ADMIN') {
      router.push('/pos');
    }
  }, [user, router]);

  const printAdmin = (kind: 'report' | 'receipt') => {
    const printClass = `print-admin-${kind}`;
    document.body.classList.add(printClass);
    try { window.print(); } finally { document.body.classList.remove(printClass); }
  };

  const triggerAlert = (type: 'success' | 'error', text: string) => {
    setAlertMsg({ type, text });
    setTimeout(() => setAlertMsg(null), 3500);
  };

  // Fetch Dashboard Analytics
  const fetchAnalytics = useCallback(async () => {
    setLoadingAnalytics(true);
    try {
      const res = await fetch('/api/admin-analytics');
      if (res.ok) {
        const data = await res.json();
        setKpis(data.kpis);
        setPayments(data.paymentBreakdown || { cash: 0, visa: 0, instapay: 0, vodafoneCash: 0, cashOut: 0 });
        setTopItems(data.topSellingItems || []);
        if (data.topSellingItemsByPeriod) {
          setTopItemsByPeriod(data.topSellingItemsByPeriod);
        } else {
          setTopItemsByPeriod({ today: data.topSellingItems || [], month: [], all: [] });
        }
        setDiscountsBreakdown(data.discountsBreakdown || []);
        setReturnsLog(data.returnsLog || []);
        setWastageLogs(data.wastageLog || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingAnalytics(false);
    }
  }, []);

  // Fetch Suppliers & Purchases
  const fetchSuppliersAndPurchases = useCallback(async () => {
    setLoadingPurchases(true);
    try {
      const [sRes, pRes] = await Promise.all([fetch('/api/suppliers'), fetch('/api/purchases')]);
      if (sRes.ok) {
        const sData = await sRes.json();
        setSuppliers(sData.suppliers || []);
      }
      if (pRes.ok) {
        const pData = await pRes.json();
        setPurchaseInvoices(pData.invoices || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingPurchases(false);
    }
  }, []);

  // Fetch Customers & Discount Reasons
  const fetchCustomersAndReasons = useCallback(async () => {
    setLoadingCustomers(true);
    try {
      const [cRes, rRes] = await Promise.all([fetch('/api/customers'), fetch('/api/discount-reasons')]);
      if (cRes.ok) {
        const cData = await cRes.json();
        setCustomers(cData.customers || []);
      }
      if (rRes.ok) {
        const rData = await rRes.json();
        setDiscountReasons(rData.reasons || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingCustomers(false);
    }
  }, []);

  // Fetch Product Costs
  const fetchProductCosts = useCallback(async () => {
    setLoadingCosts(true);
    try {
      const res = await fetch('/api/product-costs');
      if (res.ok) {
        const data = await res.json();
        setProductCosts(data.items || []);
        setTotalTodayProfit(data.totalTodayProfit || 0);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingCosts(false);
    }
  }, []);

  // Fetch Inventory & Raw Materials
  const fetchInventory = useCallback(async () => {
    setLoadingInventory(true);
    try {
      const res = await fetch('/api/inventory');
      if (res.ok) {
        const data = await res.json();
        setRawMaterials(data.rawMaterials || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingInventory(false);
    }
  }, []);

  // Fetch Detailed Reports
  const fetchDetailedReport = useCallback(async () => {
    setLoadingReport(true);
    try {
      const query = new URLSearchParams({
        startDate: reportStartDate,
        endDate: reportEndDate,
        paymentMethod: reportPaymentMethod,
        search: reportSearchItem,
      });
      const res = await fetch(`/api/reports/detailed?${query.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setDetailedReport(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingReport(false);
    }
  }, [reportStartDate, reportEndDate, reportPaymentMethod, reportSearchItem]);

  useEffect(() => {
    return scheduleEffect(() => {
      void fetchAnalytics(); void fetchSuppliersAndPurchases();
      void fetchCustomersAndReasons(); void fetchInventory();
    });
  }, [fetchAnalytics, fetchSuppliersAndPurchases, fetchCustomersAndReasons, fetchInventory]);

  useEffect(() => {
    return scheduleEffect(() => {
      if (activeTab === 'profitability') { void fetchProductCosts(); void fetchInventory(); }
      if (activeTab === 'reports') void fetchDetailedReport();
    });
  }, [activeTab, fetchProductCosts, fetchDetailedReport, fetchInventory]);

  // Add Supplier Handler
  const handleAddSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newSuppName.trim(),
          phone: newSuppPhone.trim() || null,
          companyName: newSuppCompany.trim() || null,
          address: newSuppAddress.trim() || null,
          notes: newSuppNotes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل إضافة المورد');
      triggerAlert('success', 'تمت إضافة المورد بنجاح');
      setShowAddSupplierModal(false);
      setNewSuppName('');
      setNewSuppPhone('');
      setNewSuppCompany('');
      fetchSuppliersAndPurchases();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Delete Supplier Handler
  const handleDeleteSupplier = async (id: string, name: string) => {
    if (!window.confirm(`هل أنت متأكد من حذف المورد "${name}"؟ سيتم حذف المورد مع الحفاظ على فواتير المشتريات المسجلة باسمه.`)) return;
    try {
      const res = await fetch(`/api/suppliers?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل حذف المورد');
      triggerAlert('success', `تم حذف المورد "${name}" بنجاح`);
      fetchSuppliersAndPurchases();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Add Purchase Invoice Handler
  const handleAddPurchaseInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const formattedItems = purItems
        .filter((it) => it.rawMaterialId || it.itemName)
        .map((it) => {
          const rawMat = rawMaterials.find((m) => m.id === it.rawMaterialId);
          const qty = parseFloat(it.quantity) || 0;
          const tot = parseFloat(it.totalPrice) || 0;
          const unit = qty > 0 ? tot / qty : tot;
          return {
            rawMaterialId: it.rawMaterialId || null,
            itemName: rawMat ? rawMat.name : it.itemName || 'خامة مشتريات',
            quantity: qty,
            purchaseUnit: rawMat ? rawMat.purchaseUnit : it.purchaseUnit || 'unit',
            unitPrice: unit,
            totalPrice: tot,
          };
        });

      if (formattedItems.length === 0) {
        throw new Error('يرجى اختيار خامة واحدة على الأقل وتحديد الكمية والسعر');
      }

      const supp = suppliers.find((s) => s.id === purSupplierId);

      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: purSupplierId || null,
          supplierName: supp ? supp.name : null,
          paymentMethod: purPaymentMethod,
          paidAmount: purPaidAmount ? parseFloat(purPaidAmount) : undefined,
          items: formattedItems,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل حفظ فاتورة المشتريات');

      triggerAlert('success', 'تم تسجيل فاتورة المشتريات وتحديث رصيد المخزن بنجاح!');
      setShowAddPurchaseModal(false);
      setPurItems([{ rawMaterialId: '', itemName: '', quantity: '', purchaseUnit: 'kg', totalPrice: '' }]);
      setPurPaidAmount('');
      fetchSuppliersAndPurchases();
      fetchInventory();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Settle Invoice Payment Handler
  const handleSettlePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInvoiceToPay || !paymentAmountInput) return;
    try {
      const res = await fetch('/api/purchases', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: selectedInvoiceToPay.id,
          paymentAmount: parseFloat(paymentAmountInput),
          paymentMethod: paymentMethodInput,
          notes: paymentNotesInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تسجيل السداد');
      triggerAlert('success', `تم تسجيل سداد مبلغ EGP ${paymentAmountInput} للفاتورة بنجاح!`);
      setShowPayModal(false);
      setSelectedInvoiceToPay(null);
      setPaymentAmountInput('');
      setPaymentNotesInput('');
      fetchSuppliersAndPurchases();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Add Customer Handler
  const handleAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
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
      if (!res.ok) throw new Error(data.error || 'فشل إضافة العميل');
      triggerAlert('success', 'تمت إضافة العميل بنجاح');
      setShowAddCustModal(false);
      setNewCustName('');
      setNewCustPhone('');
      setNewCustDiscount('0');
      fetchCustomersAndReasons();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Add Discount Reason Handler
  const handleAddDiscountReason = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReasonText.trim()) return;
    try {
      const res = await fetch('/api/discount-reasons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: newReasonText.trim(),
          rate: newReasonRate ? parseFloat(newReasonRate) : null,
        }),
      });
      if (!res.ok) throw new Error('فشل إضافة سبب الخصم');
      triggerAlert('success', 'تمت إضافة سبب الخصم الثابت');
      setNewReasonText('');
      setNewReasonRate('');
      fetchCustomersAndReasons();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Delete Customer Handler
  const handleDeleteCustomer = async (id: string, name: string) => {
    if (!window.confirm(`هل أنت متأكد من حذف العميل "${name}"؟`)) return;
    try {
      const res = await fetch(`/api/customers?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('فشل حذف العميل');
      triggerAlert('success', `تم حذف العميل "${name}" بنجاح`);
      fetchCustomersAndReasons();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Delete Discount Reason Handler
  const handleDeleteDiscountReason = async (id: string, reason: string) => {
    if (!window.confirm(`هل أنت متأكد من حذف سبب الخصم "${reason}"؟`)) return;
    try {
      const res = await fetch(`/api/discount-reasons?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('فشل حذف سبب الخصم');
      triggerAlert('success', `تم حذف سبب الخصم "${reason}" بنجاح`);
      fetchCustomersAndReasons();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Add Wastage Handler
  const handleAddWastage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wastageMatId || !wastageQty) return;
    try {
      const res = await fetch('/api/wastage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawMaterialId: wastageMatId,
          quantity: parseFloat(wastageQty),
          reason: wastageReason.trim(),
          loggedBy: user?.name || 'Admin',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تسجيل الهالك');
      triggerAlert('success', 'تم تسجيل الهالك وخصمه من المخزن وحساب التكلفة المفقودة');
      setShowAddWastageModal(false);
      setWastageMatId('');
      setWastageQty('');
      fetchInventory();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Add Raw Material Handler
  const handleAddRawMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMatName.trim()) return;
    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newMatName.trim(),
          purchaseUnit: newMatPurchaseUnit.trim(),
          deductUnit: newMatDeductUnit.trim(),
          conversionFactor: parseFloat(newMatConversion) || 1000,
          stockQty: parseFloat(newMatStockQty) || 0,
          minStockLevel: parseFloat(newMatMinStock) || 0,
          costPerPurchaseUnit: parseFloat(newMatCost) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل إضافة الخامة');
      triggerAlert('success', 'تمت إضافة الخامة الجديدة بنجاح وتحديث المخزن!');
      setShowAddMaterialModal(false);
      setNewMatName('');
      setNewMatStockQty('');
      setNewMatMinStock('');
      setNewMatCost('');
      fetchInventory();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Edit Raw Material Handlers
  const openEditMaterialModal = (mat: RawMaterial) => {
    setSelectedMaterialToEdit(mat);
    setEditMatName(mat.name || '');
    setEditMatPurchaseUnit(mat.purchaseUnit || 'kg');
    setEditMatDeductUnit(mat.deductUnit || 'g');
    setEditMatConversion(mat.conversionFactor !== undefined ? mat.conversionFactor.toString() : '1000');
    setEditMatStockQty(mat.stockQty !== undefined ? mat.stockQty.toString() : '0');
    setEditMatMinStock(mat.minStockLevel !== undefined ? mat.minStockLevel.toString() : '0');
    setEditMatCost(mat.costPerPurchaseUnit !== undefined ? mat.costPerPurchaseUnit.toString() : '0');
    setShowEditMaterialModal(true);
  };

  const handleEditRawMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMaterialToEdit || !editMatName.trim()) return;
    try {
      const res = await fetch('/api/inventory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawMaterialId: selectedMaterialToEdit.id,
          name: editMatName.trim(),
          purchaseUnit: editMatPurchaseUnit.trim(),
          deductUnit: editMatDeductUnit.trim(),
          conversionFactor: parseFloat(editMatConversion) || 1,
          stockQty: parseFloat(editMatStockQty) || 0,
          minStockLevel: parseFloat(editMatMinStock) || 0,
          costPerPurchaseUnit: parseFloat(editMatCost) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تعديل بيانات الخامة');
      triggerAlert('success', 'تم تعديل بيانات الخامة بنجاح وتحديث أسعار الوصفات!');
      setShowEditMaterialModal(false);
      setSelectedMaterialToEdit(null);
      fetchInventory();
      fetchProductCosts();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  const handleDeleteRawMaterial = async (id: string, name: string) => {
    if (!window.confirm(`هل أنت متأكد من حذف الخامة "${name}" من المخزن؟`)) return;
    try {
      const res = await fetch(`/api/inventory?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل حذف الخامة');
      triggerAlert('success', `تم حذف الخامة "${name}" بنجاح وتحديث المخزن`);
      fetchInventory();
      fetchProductCosts();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Auto-calculators for New Item Pricing Trio (Cost, Price, Margin)
  const handleNewCostChange = (val: string) => {
    setNewItemCost(val);
    const c = parseFloat(val);
    const p = parseFloat(newItemPrice);
    const m = parseFloat(newItemMargin);
    if (!isNaN(c) && c >= 0) {
      if (!isNaN(p) && p > 0) {
        const margin = ((p - c) / p) * 100;
        setNewItemMargin(margin.toFixed(1));
      } else if (!isNaN(m) && m < 100 && m >= 0) {
        const price = c / (1 - m / 100);
        setNewItemPrice(price.toFixed(2));
      }
    }
  };

  const handleNewPriceChange = (val: string) => {
    setNewItemPrice(val);
    const p = parseFloat(val);
    const c = parseFloat(newItemCost);
    const m = parseFloat(newItemMargin);
    if (!isNaN(p) && p > 0) {
      if (!isNaN(c) && c >= 0) {
        const margin = ((p - c) / p) * 100;
        setNewItemMargin(margin.toFixed(1));
      } else if (!isNaN(m) && m < 100 && m >= 0) {
        const cost = p * (1 - m / 100);
        setNewItemCost(cost.toFixed(2));
      }
    }
  };

  const handleNewMarginChange = (val: string) => {
    setNewItemMargin(val);
    const m = parseFloat(val);
    const c = parseFloat(newItemCost);
    const p = parseFloat(newItemPrice);
    if (!isNaN(m) && m < 100 && m >= 0) {
      if (!isNaN(c) && c > 0) {
        const price = c / (1 - m / 100);
        setNewItemPrice(price.toFixed(2));
      } else if (!isNaN(p) && p > 0) {
        const cost = p * (1 - m / 100);
        setNewItemCost(cost.toFixed(2));
      }
    }
  };

  // Auto-calculators for Edit Item Pricing Trio (Cost, Price, Margin)
  const handleEditCostChange = (val: string) => {
    setEditItemCost(val);
    const c = parseFloat(val);
    const p = parseFloat(editItemPrice);
    const m = parseFloat(editItemMargin);
    if (!isNaN(c) && c >= 0) {
      if (!isNaN(p) && p > 0) {
        const margin = ((p - c) / p) * 100;
        setEditItemMargin(margin.toFixed(1));
      } else if (!isNaN(m) && m < 100 && m >= 0) {
        const price = c / (1 - m / 100);
        setEditItemPrice(price.toFixed(2));
      }
    }
  };

  const handleEditPriceChange = (val: string) => {
    setEditItemPrice(val);
    const p = parseFloat(val);
    const c = parseFloat(editItemCost);
    const m = parseFloat(editItemMargin);
    if (!isNaN(p) && p > 0) {
      if (!isNaN(c) && c >= 0) {
        const margin = ((p - c) / p) * 100;
        setEditItemMargin(margin.toFixed(1));
      } else if (!isNaN(m) && m < 100 && m >= 0) {
        const cost = p * (1 - m / 100);
        setEditItemCost(cost.toFixed(2));
      }
    }
  };

  const handleEditMarginChange = (val: string) => {
    setEditItemMargin(val);
    const m = parseFloat(val);
    const c = parseFloat(editItemCost);
    const p = parseFloat(editItemPrice);
    if (!isNaN(m) && m < 100 && m >= 0) {
      if (!isNaN(c) && c > 0) {
        const price = c / (1 - m / 100);
        setEditItemPrice(price.toFixed(2));
      } else if (!isNaN(p) && p > 0) {
        const cost = p * (1 - m / 100);
        setEditItemCost(cost.toFixed(2));
      }
    }
  };

  // Menu Items: Create Handler
  const handleCreateMenuItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemName.trim() || !newItemCategory.trim() || !newItemPrice) {
      triggerAlert('error', 'يرجى إدخال اسم الصنف والقسم وسعر البيع');
      return;
    }
    try {
      const validRecipe = newItemIngredients
        .filter((r) => r.rawMaterialId && parseFloat(r.quantity) > 0)
        .map((r) => ({
          rawMaterialId: r.rawMaterialId,
          quantity: parseFloat(r.quantity),
        }));

      const res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newItemName.trim(),
          price: parseFloat(newItemPrice) || 0,
          cost: parseFloat(newItemCost) || 0,
          categoryName: newItemCategory.trim(),
          recipe: validRecipe,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل إضافة الصنف');
      triggerAlert('success', `تمت إضافة صنف "${newItemName.trim()}" إلى المنيو بنجاح!`);
      setShowAddItemModal(false);
      setNewItemName('');
      setNewItemCategory('');
      setNewItemCost('');
      setNewItemPrice('');
      setNewItemMargin('');
      setShowNewItemRecipeSection(false);
      setNewItemIngredients([]);
      fetchProductCosts();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Menu Items: Open Edit Modal
  const openEditItemModal = (item: ProductCostItem) => {
    setSelectedItemToEdit(item);
    setEditItemId(item.id);
    setEditItemName(item.name);
    setEditItemCategory(item.categoryName);
    setEditItemPrice(item.price.toString());
    const effectiveCost = item.cost || item.unitCost || 0;
    setEditItemCost(effectiveCost > 0 ? effectiveCost.toString() : '');
    const margin = item.price > 0 && effectiveCost >= 0 ? ((item.price - effectiveCost) / item.price) * 100 : 0;
    setEditItemMargin(margin > 0 ? margin.toFixed(1) : '');
    setShowEditItemRecipeSection(item.hasRecipe);
    const preloaded = (item.ingredients || [])
      .filter((ing) => ing.rawMaterialId)
      .map((ing) => {
        const mat = rawMaterials.find((m) => m.id === ing.rawMaterialId);
        const uCost = mat && mat.conversionFactor > 0 ? (mat.costPerPurchaseUnit || 0) / mat.conversionFactor : 0;
        return {
          rawMaterialId: ing.rawMaterialId!,
          quantity: ing.quantity.toString(),
          customUnitCost: uCost > 0 ? uCost.toFixed(3) : '',
        };
      });
    setEditItemIngredients(preloaded);
    setShowEditItemModal(true);
  };

  // Menu Items: Update Handler
  const handleUpdateMenuItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editItemId || !editItemName.trim() || !editItemCategory.trim()) {
      triggerAlert('error', 'يرجى ملء جميع البيانات الأساسية للصنف');
      return;
    }
    try {
      const validRecipe = editItemIngredients
        .filter((r) => r.rawMaterialId && parseFloat(r.quantity) > 0)
        .map((r) => ({
          rawMaterialId: r.rawMaterialId,
          quantity: parseFloat(r.quantity),
        }));

      const res = await fetch('/api/items', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editItemId,
          name: editItemName.trim(),
          price: parseFloat(editItemPrice) || 0,
          cost: parseFloat(editItemCost) || 0,
          categoryName: editItemCategory.trim(),
          recipe: validRecipe,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تعديل الصنف');
      triggerAlert('success', `تم تعديل صنف "${editItemName}" بنجاح!`);
      setShowEditItemModal(false);
      setSelectedItemToEdit(null);
      fetchProductCosts();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Menu Items: Delete Handler
  const handleDeleteMenuItem = async (id: string, name: string) => {
    if (!window.confirm(`هل أنت متأكد من حذف صنف "${name}" من المنيو؟`)) return;
    try {
      const res = await fetch(`/api/items?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل حذف الصنف');
      triggerAlert('success', `تم حذف/إخفاء صنف "${name}" من المنيو بنجاح`);
      fetchProductCosts();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message);
    }
  };

  // Fetch Expenses
  const fetchExpenses = useCallback(async () => {
    setLoadingExpenses(true);
    try {
      const res = await fetch('/api/shifts/expenses');
      if (res.ok) {
        const data = await res.json();
        setExpenses(data.expenses || []);
        setExpensesTodayTotal(data.todayTotal || 0);
        setExpensesGrandTotal(data.grandTotal || 0);
      }
    } catch (e) {
      console.error('Error fetching expenses:', e);
    } finally {
      setLoadingExpenses(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'expenses') return scheduleEffect(() => { void fetchExpenses(); });
  }, [activeTab, fetchExpenses]);

  const handleAddAdminExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminExpenseAmount || !adminExpenseReason.trim()) return;
    setSubmittingAdminExpense(true);
    try {
      const res = await fetch('/api/shifts/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseFloat(adminExpenseAmount),
          reason: adminExpenseReason.trim(),
          type: 'PAYOUT',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل تسجيل المصروف');

      triggerAlert('success', 'تم تسجيل المصروف بنجاح!');
      setAdminExpenseAmount('');
      setAdminExpenseReason('');
      setShowAddAdminExpenseModal(false);
      fetchExpenses();
      fetchAnalytics();
    } catch (caught: unknown) {
      const err = caught instanceof Error ? caught : new Error(String(caught));
      triggerAlert('error', err.message || 'خطأ في تسجيل المصروف');
    } finally {
      setSubmittingAdminExpense(false);
    }
  };

  const handleDeleteExpense = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا المصروف؟')) return;
    try {
      const res = await fetch(`/api/shifts/expenses?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        triggerAlert('success', 'تم حذف المصروف بنجاح');
        fetchExpenses();
        fetchAnalytics();
      } else {
        triggerAlert('error', 'فشل حذف المصروف');
      }
    } catch {
      triggerAlert('error', 'خطأ في حذف المصروف');
    }
  };

  const filteredExpenses = expenses.filter((exp) => {
    const q = expenseSearchQuery.toLowerCase().trim();
    return (
      !q ||
      (exp.reason && exp.reason.toLowerCase().includes(q)) ||
      (exp.shift?.cashierName && exp.shift.cashierName.toLowerCase().includes(q)) ||
      (exp.shift?.user?.name && exp.shift.user.name.toLowerCase().includes(q))
    );
  });

  // Sales Ledger Fetch
  const fetchSalesLedger = useCallback(async () => {
    setLoadingLedger(true);
    try {
      const res = await fetch('/api/sales-ledger');
      if (res.ok) {
        const data = await res.json();
        setLedgerData(data);
      }
    } catch (err) {
      console.error('Failed to fetch sales ledger:', err);
    } finally {
      setLoadingLedger(false);
    }
  }, []);

  const fetchOrderAndOpenReceipt = async (orderId: string) => {
    if (!orderId) return;
    try {
      const res = await fetch(`/api/sales-orders/${orderId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.order) {
          setSelectedOrderReceipt(data.order);
          return;
        }
      }
      triggerAlert('error', 'تعذر تحميل تفاصيل الفاتورة');
    } catch {
      triggerAlert('error', 'خطأ في الاتصال بالخادم');
    }
  };

  const openPeriodOrders = async (type: 'day' | 'month', key: string, title: string) => {
    setSelectedPeriod({ type, key, title });
    setPeriodOrders([]);
    setPeriodSummary(null);
    setLoadingPeriodOrders(true);
    setOrdersSearch('');
    setOrdersFilterPayment('ALL');
    try {
      const url = `/api/sales-ledger?${type === 'day' ? 'date=' : 'month='}${encodeURIComponent(key)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setPeriodOrders(data.orders || []);
        setPeriodSummary(data.summary || null);
      } else {
        triggerAlert('error', 'فشل تحميل فواتير هذه الفترة');
      }
    } catch (err) {
      console.error('Failed to load period orders:', err);
      triggerAlert('error', 'خطأ في الاتصال بالخادم');
    } finally {
      setLoadingPeriodOrders(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'invoices-ledger') return scheduleEffect(() => { void fetchSalesLedger(); });
  }, [activeTab, fetchSalesLedger]);

  const filteredDays = (ledgerData.days || []).filter((d) => {
    const q = ledgerSearch.toLowerCase().trim();
    return !q || d.date.includes(q) || d.dayNameAr.toLowerCase().includes(q);
  });

  const filteredMonths = (ledgerData.months || []).filter((m) => {
    const q = ledgerSearch.toLowerCase().trim();
    return !q || m.month.includes(q) || m.monthNameAr.toLowerCase().includes(q);
  });

  const filteredPeriodOrders = periodOrders.filter((order) => {
    const q = ordersSearch.toLowerCase().trim();
    const matchSearch =
      !q ||
      (order.receiptNumber && order.receiptNumber.toLowerCase().includes(q)) ||
      (order.shift?.cashierName && order.shift.cashierName.toLowerCase().includes(q)) ||
      (order.shift?.user?.name && order.shift.user.name.toLowerCase().includes(q)) ||
      (order.customer?.name && order.customer.name.toLowerCase().includes(q)) ||
      (order.customerName && order.customerName.toLowerCase().includes(q)) ||
      (order.table?.name && order.table.name.toLowerCase().includes(q)) ||
      (order.items || []).some((i) => i.item?.name?.toLowerCase().includes(q));

    const matchPayment =
      ordersFilterPayment === 'ALL' || order.paymentMethod === ordersFilterPayment;

    return matchSearch && matchPayment;
  });

  const existingCategories = Array.from(
    new Set(productCosts.map((p) => p.categoryName).filter(Boolean))
  );

  if (!mounted) return null;

  return (
    <div className="flex h-screen bg-[#070b14] text-gray-200 text-right overflow-hidden" dir="rtl">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-[#0a101d] border-l border-white/5 flex flex-col justify-between shrink-0 p-4">
        <div className="space-y-6">
          {/* Logo Brand */}
          <div className="flex items-center gap-3 px-2">
            <div className="w-10 h-10 rounded-xl overflow-hidden relative border border-white/10 shrink-0 bg-white shadow-md">
              <Image width={128} height={128} unoptimized loading="eager" src="/bon-logo.jpg" alt="BON el MOON" className="w-full h-full object-cover" />
            </div>
            <div>
              <h1 className="font-bold text-sm text-white">BON el MOON</h1>
              <p className="text-[10px] text-gray-400">لوحة التحكم والإدارة الشاملة</p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1">
            {([
              { id: 'dashboard', label: 'لوحة المؤشرات العامة', icon: BarChart3 },
              { id: 'invoices-ledger', label: 'سجل الفواتير (يومي / شهري)', icon: Calendar },
              { id: 'purchases', label: 'المشتريات والموردين', icon: Truck },
              { id: 'customers', label: 'العملاء وفئات الخصم', icon: Users },
              { id: 'returns', label: 'سجل المرتجعات', icon: RotateCcw },
              { id: 'expenses', label: 'سجل المصروفات والنثريات', icon: Receipt },
              { id: 'profitability', label: 'التكلفة والمكسب الحقيقي', icon: DollarSign },
              { id: 'inventory', label: 'المخزون وتسجيل الهالك', icon: Package },
              { id: 'reports', label: 'التقارير المخصصة', icon: FileText },
              { id: 'backup', label: 'النسخ الاحتياطي', icon: Download },
            ] as const).map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-cyan-400 border border-cyan-500/30 shadow-sm'
                      : 'text-gray-400 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Actions */}
        <div className="space-y-2 border-t border-white/5 pt-4">
          <button
            onClick={() => router.push('/pos')}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 text-xs font-bold transition-all"
          >
            <ShoppingBag className="w-4 h-4" />
            <span>الذهاب لشاشة الكاشير</span>
          </button>
          <button
            onClick={() => { logout(); router.push('/'); }}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs text-rose-400 hover:bg-rose-500/10 transition-all"
          >
            <LogOut className="w-4 h-4" />
            <span>تسجيل الخروج</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header Bar */}
        <header className="h-16 border-b border-white/5 bg-[#0a101d] px-6 flex items-center justify-between shrink-0">
          <div>
            <span className="text-xs text-gray-400">{todayLabel}</span>
            <h2 className="text-base font-bold text-white">
              {activeTab === 'dashboard' && 'لوحة التحكم والتحليلات اليومية'}
              {activeTab === 'invoices-ledger' && 'سجل فواتير المبيعات (اليومي والشهري)'}
              {activeTab === 'purchases' && 'إدارة المشتريات وحسابات الموردين'}
              {activeTab === 'customers' && 'قاعدة بيانات العملاء وفئات الخصم الثابتة'}
              {activeTab === 'returns' && 'سجل فواتير المرتجعات والاسترداد'}
              {activeTab === 'expenses' && 'سجل المصروفات والنثريات اليومية'}
              {activeTab === 'profitability' && 'التكلفة الحقيقية (COGS) وهوامش الربح للأصناف'}
              {activeTab === 'inventory' && 'جرد المخزن وتسجيل الهالك اليومي'}
              {activeTab === 'reports' && 'التقارير المفصلة والمبيعات المخصصة'}
              {activeTab === 'backup' && 'النسخ الاحتياطي التلقائي وقاعدة البيانات'}
            </h2>
          </div>

          <div className="flex items-center gap-3">
            {(loadingAnalytics || loadingPurchases || loadingCustomers || loadingCosts || loadingInventory || loadingLedger || loadingExpenses || loadingReport) && (
              <NeonBadge label="جاري تحديث البيانات..." />
            )}
            <button
              onClick={() => {
                fetchAnalytics();
                fetchSuppliersAndPurchases();
                fetchCustomersAndReasons();
                if (activeTab === 'profitability') fetchProductCosts();
                if (activeTab === 'reports') fetchDetailedReport();
                if (activeTab === 'expenses') fetchExpenses();
                if (activeTab === 'invoices-ledger') fetchSalesLedger();
                triggerAlert('success', 'تم تحديث البيانات');
              }}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 transition-all border border-white/5"
              title="تحديث البيانات"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Dynamic Body Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {loadingAnalytics && (
                <div className="glass-panel p-3.5 rounded-2xl border border-cyan-500/30 bg-gradient-to-r from-cyan-950/40 via-slate-900/60 to-purple-950/40 flex items-center justify-between shadow-lg animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="relative flex items-center justify-center w-8 h-8 rounded-xl bg-cyan-500/20 border border-cyan-500/30">
                      <Database className="w-4 h-4 text-cyan-300 animate-pulse" />
                    </div>
                    <div>
                      <span className="text-xs font-bold text-white block">جاري تحميل البيانات المالية والتحليلات...</span>
                      <span className="text-[10px] text-cyan-400/80">يتم جلب مبيعات اليوم وصافي الأرباح والمدفوعات لحظياً</span>
                    </div>
                  </div>
                  <div className="w-5 h-5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin shrink-0" />
                </div>
              )}

              {/* Top Financial KPI Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="glass-panel p-4 rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">إجمالي مبيعات اليوم (صافي)</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className="text-2xl font-bold text-cyan-400 font-mono">EGP {kpis.todaySales.toFixed(2)}</span>
                    <span className="text-[10px] text-gray-400 font-semibold">{kpis.todayOrdersCount} فاتورة</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">متوسط الفاتورة: EGP {kpis.todayAvgTicket}</span>
                </div>

                <div className="glass-panel p-4 rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">صافي الأرباح المحققة اليوم</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className={`text-2xl font-bold font-mono ${kpis.todayNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      EGP {kpis.todayNet.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-gray-400">التكلفة (COGS): EGP {kpis.todayCOGS.toFixed(2)}</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">المبيعات - تكلفة الخامات والمصروفات</span>
                </div>

                <div className="glass-panel p-4 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">إجمالي الخصومات اليومية</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className="text-2xl font-bold text-amber-400 font-mono">EGP {kpis.todayDiscounts.toFixed(2)}</span>
                    <span className="text-[10px] text-gray-400">الشهر: EGP {kpis.monthlyDiscounts.toFixed(2)}</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">مجموع الخصومات الممنوحة للعملاء</span>
                </div>

                <div className="glass-panel p-4 rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">إجمالي المرتجعات اليوم</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className="text-2xl font-bold text-rose-400 font-mono">EGP {kpis.todayReturnsAmount.toFixed(2)}</span>
                    <span className="text-[10px] text-gray-400">{kpis.todayReturnsCount} عملية إرجاع</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">مرتجع الشهر: EGP {kpis.monthlyReturnsAmount.toFixed(2)}</span>
                </div>
              </div>

              {/* Multi-Payment Methods Breakdown Bar */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h3 className="text-xs font-bold text-white flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-cyan-400" />
                  <span>تفصيل الإيرادات حسب طريقة الدفع (اليوم)</span>
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div className="p-3 bg-slate-900/60 rounded-xl border border-white/5">
                    <span className="text-[10px] text-gray-400 block">💵 نقدي (كاش)</span>
                    <span className="text-base font-bold text-emerald-400 font-mono mt-1 block">EGP {payments.cash.toFixed(2)}</span>
                  </div>
                  <div className="p-3 bg-slate-900/60 rounded-xl border border-white/5">
                    <span className="text-[10px] text-gray-400 block">💳 فيزا (Visa)</span>
                    <span className="text-base font-bold text-blue-400 font-mono mt-1 block">EGP {payments.visa.toFixed(2)}</span>
                  </div>
                  <div className="p-3 bg-slate-900/60 rounded-xl border border-white/5">
                    <span className="text-[10px] text-gray-400 block">📱 إنستا باي (InstaPay)</span>
                    <span className="text-base font-bold text-purple-400 font-mono mt-1 block">EGP {payments.instapay.toFixed(2)}</span>
                  </div>
                  <div className="p-3 bg-slate-900/60 rounded-xl border border-white/5">
                    <span className="text-[10px] text-gray-400 block">🔴 فودافون كاش</span>
                    <span className="text-base font-bold text-rose-400 font-mono mt-1 block">EGP {payments.vodafoneCash.toFixed(2)}</span>
                  </div>
                  <div className="p-3 bg-slate-900/60 rounded-xl border border-white/5">
                    <span className="text-[10px] text-gray-400 block">💸 سحب كاش بالفيزا</span>
                    <span className="text-base font-bold text-amber-400 font-mono mt-1 block">EGP {payments.cashOut.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Discounts & Top Selling Grids */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Discounts by Reason */}
                <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                  <h3 className="text-xs font-bold text-white flex items-center gap-2">
                    <Tag className="w-4 h-4 text-amber-400" />
                    <span>تحليل الخصومات حسب السبب (الشهر الحالي)</span>
                  </h3>
                  <div className="space-y-2">
                    {discountsBreakdown.length > 0 ? (
                      discountsBreakdown.map((db, idx) => (
                        <div key={idx} className="p-2.5 bg-slate-900/50 rounded-xl border border-white/5 flex items-center justify-between flex-row-reverse text-xs">
                          <span className="font-semibold text-white">{db.reason}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-gray-400">{db.count} مرات</span>
                            <span className="font-bold text-amber-400 font-mono">EGP {db.totalAmount.toFixed(2)}</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-gray-500 text-center py-4">لا توجد خصومات مسجلة هذا الشهر</p>
                    )}
                  </div>
                </div>

                {/* Top Selling Items with Period Switcher */}
                <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-white flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-emerald-400" />
                      <span>الأصناف الأكثر مبيعاً</span>
                    </h3>

                    {/* Period Switcher */}
                    <div className="flex items-center gap-1 p-0.5 bg-slate-900/80 rounded-lg border border-white/10 text-[10px]">
                      <button
                        type="button"
                        onClick={() => setTopItemsPeriod('today')}
                        className={`px-2.5 py-1 rounded-md font-bold transition-all ${
                          topItemsPeriod === 'today'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm'
                            : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        يومياً
                      </button>
                      <button
                        type="button"
                        onClick={() => setTopItemsPeriod('month')}
                        className={`px-2.5 py-1 rounded-md font-bold transition-all ${
                          topItemsPeriod === 'month'
                            ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-sm'
                            : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        شهرياً
                      </button>
                      <button
                        type="button"
                        onClick={() => setTopItemsPeriod('all')}
                        className={`px-2.5 py-1 rounded-md font-bold transition-all ${
                          topItemsPeriod === 'all'
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm'
                            : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        كل الوقت
                      </button>
                    </div>
                  </div>

                  {(() => {
                    const displayedTopItems =
                      topItemsPeriod === 'today'
                        ? (topItemsByPeriod.today || topItems || [])
                        : topItemsPeriod === 'month'
                        ? (topItemsByPeriod.month || [])
                        : (topItemsByPeriod.all || []);

                    return (
                      <div className="space-y-2">
                        {displayedTopItems.length > 0 ? (
                          displayedTopItems.map((item, idx) => (
                            <div key={idx} className="p-2.5 bg-slate-900/50 rounded-xl border border-white/5 flex items-center justify-between flex-row-reverse text-xs">
                              <div className="flex items-center gap-2">
                                <span className="w-5 h-5 rounded-full bg-slate-800 text-gray-400 flex items-center justify-center text-[10px] font-mono">
                                  #{idx + 1}
                                </span>
                                <span className="font-semibold text-white">{item.name}</span>
                              </div>
                              <div className="flex items-center gap-4">
                                <span className="text-cyan-400 font-bold">{item.qty} قطع</span>
                                <span className="font-mono text-gray-300">EGP {item.total.toFixed(2)}</span>
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="text-xs text-gray-500 text-center py-4">
                            {topItemsPeriod === 'today' && 'لم يتم تسجيل مبيعات اليوم بعد'}
                            {topItemsPeriod === 'month' && 'لم يتم تسجيل مبيعات هذا الشهر بعد'}
                            {topItemsPeriod === 'all' && 'لا توجد مبيعات مسجلة في النظام'}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* TAB: INVOICES LEDGER (DAILY & MONTHLY) */}
          {activeTab === 'invoices-ledger' && (
            <div className="space-y-6">
              {/* Header & Sub-nav Switcher */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-cyan-400" />
                    <span>سجل فواتير المبيعات (يومي / شهري)</span>
                  </h2>
                  <p className="text-xs text-gray-400">
                    أرشيف مبيعات وفواتير BON el MOON مجمعة باليوم وبالشهر مع إمكانية استعراض فواتير كل فترة وتفاصيل الإيصال
                  </p>
                </div>

                {/* Daily vs Monthly Switcher Toggle */}
                <div className="flex items-center gap-1.5 p-1 bg-slate-900/80 rounded-xl border border-white/10">
                  <button
                    onClick={() => setActiveLedgerView('daily')}
                    className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeLedgerView === 'daily'
                        ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/20'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    <Calendar className="w-3.5 h-3.5" />
                    <span>سجل الأيام (اليومي)</span>
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 text-white font-mono">
                      {ledgerData.days.length}
                    </span>
                  </button>

                  <button
                    onClick={() => setActiveLedgerView('monthly')}
                    className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeLedgerView === 'monthly'
                        ? 'bg-gradient-to-r from-purple-500 to-pink-600 text-white shadow-md shadow-purple-500/20'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    <BarChart3 className="w-3.5 h-3.5" />
                    <span>سجل الشهور (الشهري)</span>
                    <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 text-white font-mono">
                      {ledgerData.months.length}
                    </span>
                  </button>
                </div>
              </div>

              {/* Dynamic KPI Overview Cards: Today if daily, This Month if monthly */}
              {(() => {
                const isDaily = activeLedgerView === 'daily';
                const summary: Partial<LedgerSummary> = isDaily
                  ? (ledgerData.todaySummary || (ledgerData.days && ledgerData.days[0]) || {})
                  : (ledgerData.monthSummary || (ledgerData.months && ledgerData.months[0]) || {});

                const netSales = summary.totalNet || 0;
                const cogs = summary.cogs || 0;
                const netProfit = summary.netProfit !== undefined ? summary.netProfit : (netSales - cogs);
                const returnsAmount = summary.returnsAmount || 0;
                const returnsCount = summary.returnsCount || 0;
                const discounts = summary.totalDiscounts || 0;
                const ordersCount = summary.ordersCount || 0;
                const avgTicket = summary.avgTicket || 0;
                const cashDrawer = summary.payments?.CASH || 0;
                const visa = summary.payments?.VISA || 0;
                const instapay = summary.payments?.INSTAPAY || 0;
                const vodafoneCash = summary.payments?.VODAFONE_CASH || 0;

                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-gray-400 px-1">
                      <span className="font-semibold flex items-center gap-1.5 text-cyan-300">
                        {isDaily ? <Calendar className="w-4 h-4 text-cyan-400" /> : <BarChart3 className="w-4 h-4 text-purple-400" />}
                        <span>
                          {isDaily
                            ? `مؤشرات مبيعات وأرباح اليوم (${summary.dayNameAr || summary.date || 'اليوم'})`
                            : `مؤشرات مبيعات وأرباح هذا الشهر (${summary.monthNameAr || summary.month || 'الشهر الحالي'})`}
                        </span>
                      </span>
                      <span className="text-[11px] text-gray-500">
                        {isDaily ? 'تحديث لحظي لليوم الحالي' : `عبر ${summary.activeDaysCount || 0} يوم عمل نشط`}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3.5">
                      {/* 1. Net Sales */}
                      <div className="glass-panel p-3.5 rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/20 to-transparent">
                        <span className="text-[11px] text-gray-400 block">
                          {isDaily ? 'صافي مبيعات اليوم' : 'صافي مبيعات الشهر'}
                        </span>
                        <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                          <span className="text-xl font-bold text-cyan-400 font-mono">
                            EGP {netSales.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-gray-400 font-semibold">{ordersCount} فاتورة</span>
                        </div>
                        <span className="text-[10px] text-gray-500 mt-1 block">
                          {isDaily ? 'إجمالي فواتير اليوم' : 'إجمالي فواتير الشهر'}
                        </span>
                      </div>

                      {/* 2. Net Profit */}
                      <div className="glass-panel p-3.5 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/20 to-transparent">
                        <span className="text-[11px] text-gray-400 block">
                          {isDaily ? 'صافي أرباح اليوم' : 'صافي أرباح الشهر'}
                        </span>
                        <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                          <span className={`text-xl font-bold font-mono ${netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            EGP {netProfit.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-gray-400">COGS: {cogs.toFixed(0)}</span>
                        </div>
                        <span className="text-[10px] text-gray-500 mt-1 block">
                          المبيعات - تكلفة الخامات
                        </span>
                      </div>

                      {/* 3. Average Ticket */}
                      <div className="glass-panel p-3.5 rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-950/20 to-transparent">
                        <span className="text-[11px] text-gray-400 block">
                          {isDaily ? 'متوسط فاتورة اليوم' : 'متوسط فاتورة الشهر'}
                        </span>
                        <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                          <span className="text-xl font-bold text-purple-400 font-mono">
                            EGP {avgTicket.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-gray-400">متوسط الزبون</span>
                        </div>
                        <span className="text-[10px] text-gray-500 mt-1 block">
                          متوسط الفاتورة للطلب
                        </span>
                      </div>

                      {/* 4. Returns */}
                      <div className="glass-panel p-3.5 rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-950/20 to-transparent">
                        <span className="text-[11px] text-gray-400 block">
                          {isDaily ? 'مرتجعات اليوم' : 'مرتجعات الشهر'}
                        </span>
                        <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                          <span className="text-xl font-bold text-rose-400 font-mono">
                            EGP {returnsAmount.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-gray-400">{returnsCount} مرتجع</span>
                        </div>
                        <span className="text-[10px] text-gray-500 mt-1 block">
                          إجمالي مبالغ الاسترداد
                        </span>
                      </div>

                      {/* 5. Discounts */}
                      <div className="glass-panel p-3.5 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/20 to-transparent">
                        <span className="text-[11px] text-gray-400 block">
                          {isDaily ? 'خصومات اليوم' : 'خصومات الشهر'}
                        </span>
                        <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                          <span className="text-xl font-bold text-amber-400 font-mono">
                            EGP {discounts.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-gray-400">تخفيضات</span>
                        </div>
                        <span className="text-[10px] text-gray-500 mt-1 block">
                          خصومات ممنوحة للعملاء
                        </span>
                      </div>

                      {/* 6. Cash in Drawer & Payment methods */}
                      <div className="glass-panel p-3.5 rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-950/20 to-transparent">
                        <span className="text-[11px] text-gray-400 block">
                          {isDaily ? 'كاش الدرج (اليوم)' : 'كاش الدرج (الشهر)'}
                        </span>
                        <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                          <span className="text-xl font-bold text-emerald-400 font-mono">
                            EGP {cashDrawer.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-gray-400 font-mono">
                            💳 {visa.toFixed(0)}
                          </span>
                        </div>
                        <span className="text-[10px] text-gray-500 mt-1 block">
                          📱 إنستا: {instapay.toFixed(0)} | 🔴 محفظة: {vodafoneCash.toFixed(0)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* VIEW 1: DAILY LEDGER */}
              {activeLedgerView === 'daily' && (
                <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-4">
                  {/* Search & Counter */}
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="relative w-full sm:w-72">
                      <input
                        type="text"
                        value={ledgerSearch}
                        onChange={(e) => setLedgerSearch(e.target.value)}
                        placeholder="بحث باليوم أو التاريخ (مثال: الجمعة أو 2026-09)..."
                        className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                      />
                    </div>
                    <span className="text-xs text-gray-400">عدد الأيام المسجلة: {filteredDays.length} يوم</span>
                  </div>

                  {/* Daily Table / Cards */}
                  <div className="overflow-x-auto rounded-xl border border-white/5">
                    <table className="w-full text-right text-xs">
                      <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                        <tr>
                          <th className="p-3.5">اليوم والتاريخ</th>
                          <th className="p-3.5 text-center">عدد الفواتير</th>
                          <th className="p-3.5">إجمالي المبيعات</th>
                          <th className="p-3.5">الخصومات</th>
                          <th className="p-3.5">الصافي المحصل</th>
                          <th className="p-3.5">تفصيل طرق الدفع</th>
                          <th className="p-3.5 text-center">استعراض الفواتير</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {loadingLedger ? (
                          <tr>
                            <td colSpan={7}>
                              <NeonSpinner label="جاري تحميل سجل مبيعات الأيام..." />
                            </td>
                          </tr>
                        ) : filteredDays.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="p-8 text-center text-gray-500">
                              لا توجد مبيعات مسجلة في الأيام المحددة.
                            </td>
                          </tr>
                        ) : (
                          filteredDays.map((day) => (
                            <tr
                              key={day.date}
                              className="hover:bg-cyan-500/5 transition-colors cursor-pointer group"
                              onClick={() => openPeriodOrders('day', day.date, day.dayNameAr)}
                            >
                              <td className="p-3.5">
                                <div className="flex items-center gap-2">
                                  <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 group-hover:scale-105 transition-transform">
                                    <Calendar className="w-4 h-4" />
                                  </div>
                                  <div>
                                    <span className="font-bold text-white block text-sm">{day.dayNameAr}</span>
                                    <span className="text-[11px] text-gray-400 font-mono">{day.date}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="p-3.5 text-center">
                                <span className="px-2.5 py-1 rounded-full bg-slate-800 text-cyan-300 font-bold font-mono border border-cyan-500/20">
                                  {day.ordersCount} فاتورة
                                </span>
                              </td>
                              <td className="p-3.5 font-mono text-gray-300">
                                EGP {day.totalSales.toFixed(2)}
                              </td>
                              <td className="p-3.5 font-mono text-amber-400">
                                {day.totalDiscounts > 0 ? `- EGP ${day.totalDiscounts.toFixed(2)}` : '—'}
                              </td>
                              <td className="p-3.5 font-mono font-bold text-emerald-400 text-sm">
                                EGP {day.totalNet.toFixed(2)}
                              </td>
                              <td className="p-3.5">
                                <div className="flex flex-wrap gap-1.5 text-[10px]">
                                  {day.payments.CASH > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-mono">
                                      كاش: {day.payments.CASH.toFixed(0)}
                                    </span>
                                  )}
                                  {day.payments.VISA > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">
                                      فيزا: {day.payments.VISA.toFixed(0)}
                                    </span>
                                  )}
                                  {day.payments.INSTAPAY > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 font-mono">
                                      إنستا: {day.payments.INSTAPAY.toFixed(0)}
                                    </span>
                                  )}
                                  {day.payments.VODAFONE_CASH > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 font-mono">
                                      محفظة: {day.payments.VODAFONE_CASH.toFixed(0)}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-3.5 text-center">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPeriodOrders('day', day.date, day.dayNameAr);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-bold transition-all shadow-sm"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  <span>عرض الفواتير ({day.ordersCount})</span>
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* VIEW 2: MONTHLY LEDGER */}
              {activeLedgerView === 'monthly' && (
                <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-4">
                  {/* Search & Counter */}
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="relative w-full sm:w-72">
                      <input
                        type="text"
                        value={ledgerSearch}
                        onChange={(e) => setLedgerSearch(e.target.value)}
                        placeholder="بحث بالشهر (مثال: سبتمبر أو 2026-09)..."
                        className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-xs text-white text-right placeholder-gray-500 focus:border-purple-500"
                      />
                    </div>
                    <span className="text-xs text-gray-400">عدد الشهور المسجلة: {filteredMonths.length} شهر</span>
                  </div>

                  {/* Monthly Table / Cards */}
                  <div className="overflow-x-auto rounded-xl border border-white/5">
                    <table className="w-full text-right text-xs">
                      <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                        <tr>
                          <th className="p-3.5">الشهر والسنة</th>
                          <th className="p-3.5 text-center">أيام العمل</th>
                          <th className="p-3.5 text-center">عدد الفواتير</th>
                          <th className="p-3.5">إجمالي المبيعات</th>
                          <th className="p-3.5">الخصومات</th>
                          <th className="p-3.5">الصافي المحصل</th>
                          <th className="p-3.5">تفصيل طرق الدفع</th>
                          <th className="p-3.5 text-center">استعراض الفواتير</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {loadingLedger ? (
                          <tr>
                            <td colSpan={8}>
                              <NeonSpinner label="جاري تحميل سجل مبيعات الشهور..." />
                            </td>
                          </tr>
                        ) : filteredMonths.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="p-8 text-center text-gray-500">
                              لا توجد مبيعات مسجلة في الشهور المحددة.
                            </td>
                          </tr>
                        ) : (
                          filteredMonths.map((month) => (
                            <tr
                              key={month.month}
                              className="hover:bg-purple-500/5 transition-colors cursor-pointer group"
                              onClick={() => openPeriodOrders('month', month.month, month.monthNameAr)}
                            >
                              <td className="p-3.5">
                                <div className="flex items-center gap-2">
                                  <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 group-hover:scale-105 transition-transform">
                                    <BarChart3 className="w-4 h-4" />
                                  </div>
                                  <div>
                                    <span className="font-bold text-white block text-sm">{month.monthNameAr}</span>
                                    <span className="text-[11px] text-gray-400 font-mono">{month.month}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="p-3.5 text-center">
                                <span className="px-2 py-0.5 rounded bg-slate-800 text-gray-300 font-semibold font-mono">
                                  {month.activeDaysCount} يوم
                                </span>
                              </td>
                              <td className="p-3.5 text-center">
                                <span className="px-2.5 py-1 rounded-full bg-slate-800 text-purple-300 font-bold font-mono border border-purple-500/20">
                                  {month.ordersCount} فاتورة
                                </span>
                              </td>
                              <td className="p-3.5 font-mono text-gray-300">
                                EGP {month.totalSales.toFixed(2)}
                              </td>
                              <td className="p-3.5 font-mono text-amber-400">
                                {month.totalDiscounts > 0 ? `- EGP ${month.totalDiscounts.toFixed(2)}` : '—'}
                              </td>
                              <td className="p-3.5 font-mono font-bold text-emerald-400 text-sm">
                                EGP {month.totalNet.toFixed(2)}
                              </td>
                              <td className="p-3.5">
                                <div className="flex flex-wrap gap-1.5 text-[10px]">
                                  {month.payments.CASH > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-mono">
                                      كاش: {month.payments.CASH.toFixed(0)}
                                    </span>
                                  )}
                                  {month.payments.VISA > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">
                                      فيزا: {month.payments.VISA.toFixed(0)}
                                    </span>
                                  )}
                                  {month.payments.INSTAPAY > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 font-mono">
                                      إنستا: {month.payments.INSTAPAY.toFixed(0)}
                                    </span>
                                  )}
                                  {month.payments.VODAFONE_CASH > 0 && (
                                    <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 font-mono">
                                      محفظة: {month.payments.VODAFONE_CASH.toFixed(0)}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-3.5 text-center">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPeriodOrders('month', month.month, month.monthNameAr);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 text-xs font-bold transition-all shadow-sm"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  <span>عرض فواتير الشهر ({month.ordersCount})</span>
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: PURCHASES & SUPPLIERS */}
          {activeTab === 'purchases' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">إدارة الموردين وفواتير المشتريات</h3>
                  <p className="text-xs text-gray-400">سجل مشتريات الخامات، وتابع حسابات ومديونيات الموردين</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowAddSupplierModal(true)}
                    className="px-3.5 py-2 rounded-xl bg-purple-500/20 text-purple-300 border border-purple-500/30 text-xs font-bold hover:bg-purple-500/30 flex items-center gap-1.5"
                  >
                    <PlusCircle className="w-4 h-4" />
                    <span>+ إضافة مورد جديد</span>
                  </button>
                  <button
                    onClick={() => setShowAddPurchaseModal(true)}
                    className="px-3.5 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-bold hover:bg-cyan-500/30 flex items-center gap-1.5"
                  >
                    <Receipt className="w-4 h-4" />
                    <span>+ تسجيل فاتورة مشتريات</span>
                  </button>
                </div>
              </div>

              {/* Suppliers List Table */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h4 className="text-xs font-bold text-white">قائمة الموردين والأرصدة</h4>
                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">اسم المورد</th>
                        <th className="p-3">الشركة / المؤسسة</th>
                        <th className="p-3">الهاتف</th>
                        <th className="p-3">إجمالي المسحوبات</th>
                        <th className="p-3">المبلغ المدفوع</th>
                        <th className="p-3">الرصيد المتبقي (آجل)</th>
                        <th className="p-3 text-center">الإجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingPurchases ? (
                        <tr>
                          <td colSpan={7}>
                            <NeonSpinner label="جاري تحميل قائمة الموردين..." />
                          </td>
                        </tr>
                      ) : suppliers.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-8 text-center text-gray-500">
                            لا يوجد موردين مسجلين حالياً
                          </td>
                        </tr>
                      ) : (
                        suppliers.map((s) => (
                          <tr key={s.id} className="hover:bg-white/5">
                            <td className="p-3 font-semibold text-white">{s.name}</td>
                            <td className="p-3 text-gray-300">{s.companyName || '-'}</td>
                            <td className="p-3 text-gray-400 font-mono">{s.phone || '-'}</td>
                            <td className="p-3 font-mono text-cyan-400">EGP {s.totalPurchases?.toFixed(2) || '0.00'}</td>
                            <td className="p-3 font-mono text-emerald-400">EGP {s.totalPaid?.toFixed(2) || '0.00'}</td>
                            <td className="p-3 font-mono font-bold text-rose-400">EGP {s.remainingBalance?.toFixed(2) || '0.00'}</td>
                            <td className="p-3 text-center">
                              <button
                                onClick={() => handleDeleteSupplier(s.id, s.name)}
                                className="px-2 py-1 rounded-lg text-rose-400 hover:text-white hover:bg-rose-500/20 border border-rose-500/20 inline-flex items-center gap-1 text-xs transition-all active:scale-95"
                                title="حذف المورد"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>مسح</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Recent Purchase Invoices */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h4 className="text-xs font-bold text-white">سجل فواتير المشتريات المسجلة</h4>
                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">رقم الفاتورة</th>
                        <th className="p-3">المورد</th>
                        <th className="p-3">التاريخ</th>
                        <th className="p-3">الأصناف والخامات</th>
                        <th className="p-3">طريقة الدفع</th>
                        <th className="p-3">الإجمالي</th>
                        <th className="p-3">المدفوع</th>
                        <th className="p-3">المتبقي</th>
                        <th className="p-3 text-center">الإجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingPurchases ? (
                        <tr>
                          <td colSpan={9}>
                            <NeonSpinner label="جاري تحميل فواتير المشتريات..." />
                          </td>
                        </tr>
                      ) : purchaseInvoices.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="p-8 text-center text-gray-500">
                            لا توجد فواتير مشتريات مسجلة حالياً
                          </td>
                        </tr>
                      ) : (
                        purchaseInvoices.map((inv) => (
                          <tr key={inv.id} className="hover:bg-white/5">
                            <td className="p-3 font-mono font-bold text-white">{inv.invoiceNumber}</td>
                            <td className="p-3 text-cyan-300">{inv.supplier?.name || inv.supplierName || 'مورد عام'}</td>
                            <td className="p-3 text-gray-400">{new Date(inv.invoiceDate).toLocaleDateString()}</td>
                            <td className="p-3">
                              <span className="text-gray-300">{inv.items?.map((it) => `${it.itemName} (${it.quantity} ${it.purchaseUnit})`).join(', ')}</span>
                            </td>
                            <td className="p-3 text-gray-300">{inv.paymentMethod}</td>
                            <td className="p-3 font-mono font-bold text-white">EGP {inv.totalAmount.toFixed(2)}</td>
                            <td className="p-3 font-mono text-emerald-400">EGP {inv.paidAmount.toFixed(2)}</td>
                            <td className="p-3 font-mono text-rose-400">EGP {inv.remainingAmount.toFixed(2)}</td>
                            <td className="p-3 text-center">
                              {inv.remainingAmount > 0 ? (
                                <button
                                  onClick={() => {
                                    setSelectedInvoiceToPay(inv);
                                    setPaymentAmountInput(inv.remainingAmount.toString());
                                    setPaymentMethodInput(inv.paymentMethod === 'DEFERRED' ? 'CASH' : inv.paymentMethod);
                                    setShowPayModal(true);
                                  }}
                                  className="px-3 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold hover:bg-emerald-500/30 inline-flex items-center gap-1 shadow-sm transition-all active:scale-95"
                                >
                                  <DollarSign className="w-3.5 h-3.5" />
                                  <span>تسديد دفعة</span>
                                </button>
                              ) : (
                                <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg font-semibold border border-emerald-500/20 inline-block">
                                  مسددة بالكامل ✓
                                </span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: CUSTOMERS & DISCOUNT TIERS */}
          {activeTab === 'customers' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">قاعدة بيانات العملاء وفئات الخصم</h3>
                  <p className="text-xs text-gray-400">سجل عملاء الكافيه والشركات والمستشفيات مع نسب الخصم المخصصة</p>
                </div>
                <button
                  onClick={() => setShowAddCustModal(true)}
                  className="px-3.5 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-bold hover:bg-cyan-500/30 flex items-center gap-1.5"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>+ إضافة عميل جديد</span>
                </button>
              </div>

              {/* Customers Table */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h4 className="text-xs font-bold text-white">العملاء المسجلون</h4>
                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">اسم العميل</th>
                        <th className="p-3">فئة العميل</th>
                        <th className="p-3">رقم الهاتف</th>
                        <th className="p-3">نسبة الخصم الثابتة</th>
                        <th className="p-3">عدد الطلبات</th>
                        <th className="p-3">إجمالي المسحوبات</th>
                        <th className="p-3">إجمالي الخصم الممنوح</th>
                        <th className="p-3 text-center">حذف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingCustomers ? (
                        <tr>
                          <td colSpan={8}>
                            <NeonSpinner label="جاري تحميل قاعدة بيانات العملاء..." />
                          </td>
                        </tr>
                      ) : customers.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="p-8 text-center text-gray-500">
                            لا يوجد عملاء مسجلين حالياً
                          </td>
                        </tr>
                      ) : (
                        customers.map((c) => (
                          <tr key={c.id} className="hover:bg-white/5">
                            <td className="p-3 font-semibold text-white">{c.name}</td>
                            <td className="p-3">
                              <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-300 border border-purple-500/20 text-[10px]">
                                {c.type === 'COMPANY' && 'شركة / مؤسسة'}
                                {c.type === 'HOSPITAL' && 'مستشفى / أطباء'}
                                {c.type === 'CAFE' && 'كافيه / مطعم'}
                                {c.type === 'INDIVIDUAL' && 'زبون مميز'}
                                {c.type === 'OTHER' && 'أخرى'}
                              </span>
                            </td>
                            <td className="p-3 font-mono text-gray-400">{c.phone || '-'}</td>
                            <td className="p-3 font-bold text-amber-400">{c.discountRate}%</td>
                            <td className="p-3 text-gray-300">{c.totalOrders || 0}</td>
                            <td className="p-3 font-mono text-cyan-400">EGP {c.totalSpent?.toFixed(2) || '0.00'}</td>
                            <td className="p-3 font-mono text-rose-400">EGP {c.totalDiscountReceived?.toFixed(2) || '0.00'}</td>
                            <td className="p-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleDeleteCustomer(c.id, c.name)}
                                className="p-1.5 text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all"
                                title="حذف العميل"
                              >
                                <Trash2 className="w-4 h-4 mx-auto" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Fixed Discount Reasons Manager */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-4">
                <h4 className="text-xs font-bold text-white flex items-center gap-2">
                  <Tag className="w-4 h-4 text-amber-400" />
                  <span>إدارة أسباب الخصم الثابتة (تظهر في قائمة الكاشير)</span>
                </h4>

                <form onSubmit={handleAddDiscountReason} className="flex gap-3 items-center">
                  <input
                    type="text"
                    required
                    value={newReasonText}
                    onChange={(e) => setNewReasonText(e.target.value)}
                    placeholder="سبب الخصم (مثال: خصم موظفين، عرض ترويجي)"
                    className="flex-1 bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white text-right"
                  />
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newReasonRate}
                    onChange={(e) => setNewReasonRate(e.target.value)}
                    placeholder="النسبة الافتراضية % (اختياري)"
                    className="w-40 bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white text-right"
                  />
                  <button type="submit" className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl text-xs">
                    + إضافة سبب
                  </button>
                </form>

                <div className="flex flex-wrap gap-2 pt-2">
                  {discountReasons.map((dr) => (
                    <div key={dr.id} className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white group hover:border-white/20">
                      <span>{dr.reason}</span>
                      {dr.rate && <span className="text-amber-400 font-bold">({dr.rate}%)</span>}
                      <button
                        type="button"
                        onClick={() => handleDeleteDiscountReason(dr.id, dr.reason)}
                        className="text-gray-500 hover:text-rose-400 p-0.5 rounded transition-all mr-1"
                        title="حذف هذا السبب"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: RETURNS LOG */}
          {activeTab === 'returns' && (
            <div className="space-y-6">
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h4 className="text-xs font-bold text-white flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-rose-400" />
                  <span>سجل فواتير المرتجعات والاسترداد</span>
                </h4>
                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">رقم الإيصال</th>
                        <th className="p-3">الكاشير</th>
                        <th className="p-3">التاريخ والوقت</th>
                        <th className="p-3">المبلغ المسترد</th>
                        <th className="p-3">سبب الإرجاع</th>
                        <th className="p-3">إعادة الخامات</th>
                        <th className="p-3 text-center">الفاتورة الأصلية</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingAnalytics ? (
                        <tr>
                          <td colSpan={7}>
                            <NeonSpinner label="جاري تحميل سجل فواتير المرتجعات..." />
                          </td>
                        </tr>
                      ) : returnsLog.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-8 text-center text-gray-500">
                            لا توجد فواتير مرتجعات مسجلة
                          </td>
                        </tr>
                      ) : (
                        returnsLog.map((ret) => (
                          <tr key={ret.id} className="hover:bg-white/5 transition-colors">
                            <td className="p-3">
                              <button
                                type="button"
                                onClick={() => {
                                  if (ret.order) {
                                    setSelectedOrderReceipt(ret.order);
                                  } else {
                                    fetchOrderAndOpenReceipt(ret.orderId);
                                  }
                                }}
                                className="font-mono font-bold text-cyan-400 hover:text-cyan-300 hover:underline inline-flex items-center gap-1.5 transition-colors"
                                title="اضغط لعرض تفاصيل الفاتورة الأصلية"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                <span>{ret.receiptNumber || ret.order?.receiptNumber || `#${ret.orderId?.slice(0, 8)}`}</span>
                              </button>
                            </td>
                            <td className="p-3 text-cyan-300">{ret.cashierName || 'كاشير'}</td>
                            <td className="p-3 text-gray-400 font-mono text-[11px]">{new Date(ret.createdAt).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}</td>
                            <td className="p-3 font-mono font-bold text-rose-400">EGP {ret.refundAmount.toFixed(2)}</td>
                            <td className="p-3 text-amber-300 font-medium">{ret.reason}</td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] ${ret.restockItems ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400'}`}>
                                {ret.restockItems ? 'نعم (تمت الإعادة)' : 'لا'}
                              </span>
                            </td>
                            <td className="p-3 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  if (ret.order) {
                                    setSelectedOrderReceipt(ret.order);
                                  } else {
                                    fetchOrderAndOpenReceipt(ret.orderId);
                                  }
                                }}
                                className="px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold inline-flex items-center gap-1 transition-all shadow-sm"
                                title="عرض تفاصيل الفاتورة والإيصال"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>عرض الفاتورة</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: PRODUCT PROFITABILITY & REAL COSTS */}
          {activeTab === 'profitability' && (
            <div className="space-y-6">
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-white">التكلفة الحقيقية (COGS) وهامش الربح للأصناف</h3>
                    <p className="text-xs text-gray-400">محسوبة تلقائياً من مقادير الوصفة (Recipes) وتكلفة شراء الخامات</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        setNewItemName('');
                        setNewItemCategory('');
                        setNewItemPrice('');
                        setNewItemIngredients([]);
                        setShowAddItemModal(true);
                      }}
                      className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-xs font-bold hover:from-emerald-600 hover:to-cyan-600 flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
                    >
                      <PlusCircle className="w-4 h-4" />
                      <span>+ إضافة صنف جديد للمنيو</span>
                    </button>
                    <div className="p-2.5 px-3 bg-purple-500/10 border border-purple-500/20 rounded-xl text-left">
                      <span className="text-[10px] text-gray-400 block">إجمالي أرباح اليوم المحققة من الأصناف</span>
                      <span className="text-sm font-bold text-emerald-400 font-mono">EGP {totalTodayProfit.toFixed(2)}</span>
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">اسم الصنف</th>
                        <th className="p-3">القسم</th>
                        <th className="p-3">سعر البيع</th>
                        <th className="p-3">التكلفة الفعلية</th>
                        <th className="p-3">هامش الربح / قطعة</th>
                        <th className="p-3">نسبة الربحية %</th>
                        <th className="p-3">مبيعات اليوم (قطع)</th>
                        <th className="p-3">صافي ربح اليوم</th>
                        <th className="p-3 text-center">الإجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingCosts ? (
                        <tr>
                          <td colSpan={9}>
                            <NeonSpinner label="جاري تحميل قائمة الأصناف والتكاليف..." />
                          </td>
                        </tr>
                      ) : productCosts.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="p-8 text-center text-gray-500">
                            لا توجد أصناف مسجلة حالياً
                          </td>
                        </tr>
                      ) : (
                        productCosts.map((item) => (
                          <tr key={item.id} className="hover:bg-white/5">
                            <td className="p-3 font-semibold text-white">{item.name}</td>
                            <td className="p-3 text-gray-400">{item.categoryName}</td>
                            <td className="p-3 font-mono text-cyan-400">EGP {item.price.toFixed(2)}</td>
                            <td className="p-3 font-mono text-amber-400">EGP {item.unitCost.toFixed(2)}</td>
                            <td className="p-3 font-mono text-emerald-400">EGP {item.profitPerUnit.toFixed(2)}</td>
                            <td className="p-3 font-bold text-purple-300">{item.profitMarginPct}%</td>
                            <td className="p-3 font-bold text-white">{item.qtySoldToday}</td>
                            <td className="p-3 font-mono font-bold text-emerald-400">EGP {item.totalProfitToday.toFixed(2)}</td>
                            <td className="p-3 text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  onClick={() => openEditItemModal(item)}
                                  className="px-2 py-1 rounded-lg text-cyan-400 hover:text-white hover:bg-cyan-500/20 border border-cyan-500/20 inline-flex items-center gap-1 text-xs transition-all active:scale-95"
                                  title="تعديل الصنف والوصفة"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                  <span>تعديل</span>
                                </button>
                                <button
                                  onClick={() => handleDeleteMenuItem(item.id, item.name)}
                                  className="px-2 py-1 rounded-lg text-rose-400 hover:text-white hover:bg-rose-500/20 border border-rose-500/20 inline-flex items-center gap-1 text-xs transition-all active:scale-95"
                                  title="حذف الصنف"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>مسح</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: INVENTORY & WASTAGE */}
          {activeTab === 'inventory' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-white">جرد المخزن وإدارة الخامات والهوالك</h3>
                  <p className="text-xs text-gray-400">إضافة الخامات ومتابعة الأرصدة وتوثيق الهدر والتلف مع حساب التكلفة المفقودة</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowAddMaterialModal(true)}
                    className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-600 text-white text-xs font-bold hover:from-cyan-600 hover:to-purple-700 flex items-center gap-1.5 shadow-lg shadow-cyan-500/20"
                  >
                    <PlusCircle className="w-4 h-4" />
                    <span>+ إضافة خامة جديدة</span>
                  </button>
                  <button
                    onClick={() => setShowAddWastageModal(true)}
                    className="px-3.5 py-2 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-bold hover:bg-rose-500/30 flex items-center gap-1.5"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    <span>+ تسجيل هالك جديد</span>
                  </button>
                </div>
              </div>

              {/* Raw Materials Table */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h4 className="text-xs font-bold text-white">أرصدة الخامات الحالية</h4>
                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">اسم الخامة</th>
                        <th className="p-3">الرصيد المتاح</th>
                        <th className="p-3">حد التنبيه</th>
                        <th className="p-3">سعر تكلفة وحدة الشراء</th>
                        <th className="p-3">الحالة</th>
                        <th className="p-3 text-center">الإجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingInventory ? (
                        <tr>
                          <td colSpan={6}>
                            <NeonSpinner label="جاري تحميل بيانات المخزون والأرصدة..." />
                          </td>
                        </tr>
                      ) : rawMaterials.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center text-gray-500">
                            لا توجد خامات مسجلة في المخزن حالياً
                          </td>
                        </tr>
                      ) : (
                        rawMaterials.map((mat) => (
                          <tr key={mat.id} className="hover:bg-white/5">
                            <td className="p-3 font-semibold text-white">{mat.name}</td>
                            <td className="p-3 font-mono font-bold text-cyan-400">{mat.stockQty} {mat.deductUnit}</td>
                            <td className="p-3 text-gray-400">{mat.minStockLevel} {mat.deductUnit}</td>
                            <td className="p-3 font-mono text-amber-300">EGP {mat.costPerPurchaseUnit?.toFixed(2) || '0.00'} / {mat.purchaseUnit}</td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] ${mat.stockQty < mat.minStockLevel ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                {mat.stockQty < mat.minStockLevel ? 'ناقص' : 'آمن'}
                              </span>
                            </td>
                            <td className="p-3 text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  onClick={() => openEditMaterialModal(mat)}
                                  className="px-2 py-1 rounded-lg text-cyan-400 hover:text-white hover:bg-cyan-500/20 border border-cyan-500/20 inline-flex items-center gap-1 text-xs transition-all active:scale-95"
                                  title="تعديل بيانات الخامة"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                  <span>تعديل</span>
                                </button>
                                <button
                                  onClick={() => handleDeleteRawMaterial(mat.id, mat.name)}
                                  className="px-2 py-1 rounded-lg text-rose-400 hover:text-white hover:bg-rose-500/20 border border-rose-500/20 inline-flex items-center gap-1 text-xs transition-all active:scale-95"
                                  title="حذف الخامة"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>مسح</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Wastage Logs Table */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                <h4 className="text-xs font-bold text-white">سجل الهالك والتلفيات</h4>
                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">الخامة</th>
                        <th className="p-3">الكمية التالفة</th>
                        <th className="p-3">التكلفة المفقودة</th>
                        <th className="p-3">السبب</th>
                        <th className="p-3">المسؤول</th>
                        <th className="p-3">التاريخ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {wastageLogs.map((w) => (
                        <tr key={w.id} className="hover:bg-white/5">
                          <td className="p-3 font-semibold text-white">{w.rawMaterial?.name}</td>
                          <td className="p-3 font-mono text-rose-400 font-bold">{w.quantity} {w.rawMaterial?.deductUnit}</td>
                          <td className="p-3 font-mono text-rose-300">EGP {w.costAmount?.toFixed(2) || '0.00'}</td>
                          <td className="p-3 text-gray-300">{w.reason}</td>
                          <td className="p-3 text-gray-400">{w.loggedBy || 'Admin'}</td>
                          <td className="p-3 text-gray-500">{new Date(w.createdAt).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 7: CUSTOM DETAILED REPORTS */}
          {activeTab === 'reports' && (
            <div className="space-y-6 admin-report-print">
              {/* Filter Controls */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-4">
                <h3 className="text-xs font-bold text-white flex items-center gap-2">
                  <FileText className="w-4 h-4 text-cyan-400" />
                  <span>تصفية واستخراج تقرير المبيعات والأرباح المخصص</span>
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">من تاريخ</label>
                    <input
                      type="date"
                      value={reportStartDate}
                      onChange={(e) => setReportStartDate(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">إلى تاريخ</label>
                    <input
                      type="date"
                      value={reportEndDate}
                      onChange={(e) => setReportEndDate(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">طريقة الدفع</label>
                    <select
                      value={reportPaymentMethod}
                      onChange={(e) => setReportPaymentMethod(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                    >
                      <option value="ALL">جميع طرق الدفع</option>
                      <option value="CASH">نقدي (كاش)</option>
                      <option value="VISA">فيزا (Visa)</option>
                      <option value="INSTAPAY">إنستا باي</option>
                      <option value="VODAFONE_CASH">فودافون كاش</option>
                      <option value="CASH_OUT">سحب كاش بالفيزا</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">بحث في جدول الأصناف</label>
                    <input
                      type="text"
                      value={reportSearchItem}
                      onChange={(e) => setReportSearchItem(e.target.value)}
                      placeholder="مثال: بن برازيلي، اسبريسو..."
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                    />
                  </div>
                </div>

                <div className="flex justify-between items-center pt-2">
                  <button
                    onClick={fetchDetailedReport}
                    className="px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingReport ? 'animate-spin' : ''}`} />
                    <span>توليد التقرير</span>
                  </button>

                  <button
                    onClick={() => printAdmin('report')}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>طباعة التقرير</span>
                  </button>
                </div>
              </div>

              {/* Report Summary Cards */}
              {detailedReport && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="glass-panel p-4 rounded-xl border border-white/5">
                      <span className="text-[10px] text-gray-400 block">إجمالي الإيرادات للفترة</span>
                      <span className="text-xl font-bold text-cyan-400 font-mono mt-1 block">
                        EGP {detailedReport.summary.totalNetRevenue.toFixed(2)}
                      </span>
                    </div>
                    <div className="glass-panel p-4 rounded-xl border border-white/5">
                      <span className="text-[10px] text-gray-400 block">التكلفة الفعلية (COGS)</span>
                      <span className="text-xl font-bold text-amber-400 font-mono mt-1 block">
                        EGP {detailedReport.summary.totalCOGS.toFixed(2)}
                      </span>
                    </div>
                    <div className="glass-panel p-4 rounded-xl border border-white/5">
                      <span className="text-[10px] text-gray-400 block">صافي الأرباح المحققة</span>
                      <span className="text-xl font-bold text-emerald-400 font-mono mt-1 block">
                        EGP {detailedReport.summary.overallNetProfit.toFixed(2)}
                      </span>
                    </div>
                    <div className="glass-panel p-4 rounded-xl border border-white/5">
                      <span className="text-[10px] text-gray-400 block">نسبة هامش الربح الإجمالي</span>
                      <span className="text-xl font-bold text-purple-300 font-mono mt-1 block">
                        {detailedReport.summary.overallMarginPct}%
                      </span>
                    </div>
                  </div>

                  {/* Items Breakdown Table */}
                  <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-3">
                    <h4 className="text-xs font-bold text-white">تفصيل مبيعات وأرباح الأصناف خلال الفترة</h4>
                    <div className="overflow-x-auto rounded-xl border border-white/5">
                      <table className="w-full text-right text-xs">
                        <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                          <tr>
                            <th className="p-3">اسم الصنف</th>
                            <th className="p-3">القسم</th>
                            <th className="p-3">الكمية المباعة</th>
                            <th className="p-3">إجمالي الإيرادات</th>
                            <th className="p-3">التكلفة الإجمالية</th>
                            <th className="p-3">صافي الربح</th>
                            <th className="p-3">هامش الربح %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {detailedReport.itemsSummary.map((it) => (
                            <tr key={it.id} className="hover:bg-white/5">
                              <td className="p-3 font-semibold text-white">{it.name}</td>
                              <td className="p-3 text-gray-400">{it.categoryName}</td>
                              <td className="p-3 font-bold text-white">{it.qtySold}</td>
                              <td className="p-3 font-mono text-cyan-400">EGP {it.grossRevenue.toFixed(2)}</td>
                              <td className="p-3 font-mono text-amber-400">EGP {it.totalCost.toFixed(2)}</td>
                              <td className="p-3 font-mono font-bold text-emerald-400">EGP {it.netProfit.toFixed(2)}</td>
                              <td className="p-3 font-bold text-purple-300">{it.marginPct}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB: EXPENSES LOG */}
          {activeTab === 'expenses' && (
            <div className="space-y-6">
              {/* Header & KPI cards */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Receipt className="w-5 h-5 text-amber-400" />
                    <span>سجل المصروفات والنثريات اليومية (Cash Drawer Payouts)</span>
                  </h2>
                  <p className="text-xs text-gray-400">متابعة كافة المبالغ المصروفة من درج الكاش بالورديات مع تفاصيل الكاشير والبيان</p>
                </div>
                <button
                  onClick={() => setShowAddAdminExpenseModal(true)}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white text-xs font-bold shadow-lg shadow-amber-500/20 transition-all"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>تسجيل مصروف جديد</span>
                </button>
              </div>

              {/* KPI Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="glass-panel p-4 rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">مصروفات اليوم</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className="text-2xl font-bold text-amber-400 font-mono">EGP {expensesTodayTotal.toFixed(2)}</span>
                    <span className="text-[10px] text-gray-400">من الدرج اليوم</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">تخصم تلقائياً من صافي كاش اليومية</span>
                </div>

                <div className="glass-panel p-4 rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">إجمالي المصروفات المسجلة</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className="text-2xl font-bold text-purple-400 font-mono">EGP {expensesGrandTotal.toFixed(2)}</span>
                    <span className="text-[10px] text-gray-400">{expenses.length} حركة صرف</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">مجموع كل النثريات بالسيستم</span>
                </div>

                <div className="glass-panel p-4 rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/20 to-transparent">
                  <span className="text-[11px] text-gray-400 block">متوسط حركة الصرف</span>
                  <div className="flex items-baseline justify-between mt-1 flex-row-reverse">
                    <span className="text-2xl font-bold text-cyan-400 font-mono">
                      EGP {expenses.length > 0 ? (expensesGrandTotal / expenses.length).toFixed(2) : '0.00'}
                    </span>
                    <span className="text-[10px] text-gray-400">متوسط العملية</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-1 block">لكل إذن صرف</span>
                </div>
              </div>

              {/* Table with Search */}
              <div className="glass-panel p-5 rounded-2xl border border-white/5 space-y-4">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                  <div className="relative w-full sm:w-72">
                    <input
                      type="text"
                      value={expenseSearchQuery}
                      onChange={(e) => setExpenseSearchQuery(e.target.value)}
                      placeholder="بحث في السبب أو اسم الكاشير..."
                      className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-xs text-white text-right placeholder-gray-500 focus:border-amber-500"
                    />
                  </div>
                  <span className="text-xs text-gray-400">عدد الحركات: {filteredExpenses.length}</span>
                </div>

                <div className="overflow-x-auto rounded-xl border border-white/5">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-900/80 text-gray-400 border-b border-white/5">
                      <tr>
                        <th className="p-3">التاريخ والوقت</th>
                        <th className="p-3">الكاشير والوردية</th>
                        <th className="p-3">بيان وسبب المصروف</th>
                        <th className="p-3">المبلغ المصروف</th>
                        <th className="p-3 text-center">إجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {loadingExpenses ? (
                        <tr>
                          <td colSpan={5}>
                            <NeonSpinner label="جاري تحميل سجل المصروفات..." />
                          </td>
                        </tr>
                      ) : filteredExpenses.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="p-8 text-center text-gray-500">
                            لا توجد مصروفات مسجلة حتى الآن.
                          </td>
                        </tr>
                      ) : (
                        filteredExpenses.map((exp) => (
                          <tr key={exp.id} className="hover:bg-white/5 transition-colors">
                            <td className="p-3 text-gray-300 font-mono">
                              {new Date(exp.createdAt).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}
                            </td>
                            <td className="p-3">
                              <span className="text-cyan-300 font-semibold">{exp.shift?.cashierName || exp.shift?.user?.name || 'كاشير'}</span>
                              <span className="text-[10px] text-gray-500 block font-mono">وردية #{exp.shiftId.slice(0, 8)}</span>
                            </td>
                            <td className="p-3">
                              <span className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-300 font-semibold border border-amber-500/20">
                                {exp.reason}
                              </span>
                            </td>
                            <td className="p-3 font-mono font-bold text-rose-400 text-sm">
                              - EGP {Number(exp.amount).toFixed(2)}
                            </td>
                            <td className="p-3 text-center">
                              <button
                                onClick={() => handleDeleteExpense(exp.id)}
                                className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-all"
                                title="حذف المصروف"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 8: DATABASE BACKUP */}
          {activeTab === 'backup' && (
            <div className="space-y-6">
              <div className="glass-panel p-6 rounded-2xl border border-white/5 space-y-4">
                <div className="flex items-center gap-3">
                  <Download className="w-6 h-6 text-cyan-400" />
                  <div>
                    <h3 className="text-sm font-bold text-white">النسخ الاحتياطي التلقائي والمحلي للبيانات</h3>
                    <p className="text-xs text-gray-400">حفظ وتنزيل كامل قاعدة البيانات لضمان الحفاظ على البيانات والمعاملات</p>
                  </div>
                </div>

                <div className="p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-xl space-y-2 text-xs text-cyan-300">
                  <p className="font-bold">✓ النسخ الاحتياطي التلقائي مفعل:</p>
                  <p className="text-gray-300">
                    يمكنك تشغيل ملف <code className="px-1.5 py-0.5 rounded bg-black/40 text-white font-mono">نسخ-احتياطي-للداتابيز.bat</code> الموجود على سطح المكتب في أي وقت لأخذ باك اب محلي تلقائي في مجلد <code className="px-1.5 py-0.5 rounded bg-black/40 text-white font-mono">backups</code>.
                  </p>
                </div>

                <div className="pt-2">
                  <a
                    href="/api/backup"
                    download
                    className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold text-xs shadow-lg"
                  >
                    <Download className="w-4 h-4" />
                    <span>تحميل نسخة احتياطية فورية (JSON Snapshot)</span>
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* MODALS: Add Supplier */}
      {showAddSupplierModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddSupplierModal(false)}>
          <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowAddSupplierModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            <h3 className="text-base font-bold text-white mb-3">إضافة مورد جديد</h3>
            <form onSubmit={handleAddSupplier} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-300 mb-1">اسم المورد</label>
                <input required type="text" value={newSuppName} onChange={(e) => setNewSuppName(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="مثال: شركة النيل للتوريدات" />
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">اسم الشركة / المؤسسة</label>
                <input type="text" value={newSuppCompany} onChange={(e) => setNewSuppCompany(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="اسم الشركة" />
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">رقم الهاتف</label>
                <input type="text" value={newSuppPhone} onChange={(e) => setNewSuppPhone(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="01xxxxxxxxx" />
              </div>
              <button type="submit" className="w-full py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs mt-2">
                حفظ المورد
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODALS: Add Purchase Invoice */}
      {showAddPurchaseModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddPurchaseModal(false)}>
          <div className="w-full max-w-2xl glass-panel rounded-2xl p-6 relative text-right max-h-[85vh] overflow-y-auto" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowAddPurchaseModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            <h3 className="text-base font-bold text-white mb-3">تسجيل فاتورة مشتريات وتوريد</h3>
            <form onSubmit={handleAddPurchaseInvoice} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-300 mb-1">المورد</label>
                  <select value={purSupplierId} onChange={(e) => setPurSupplierId(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right">
                    <option value="">اختار مورد (أو اترك لمورد عام)...</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} {s.companyName ? `(${s.companyName})` : ''}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">طريقة الدفع</label>
                  <select value={purPaymentMethod} onChange={(e) => setPurPaymentMethod(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right">
                    <option value="CASH">نقدي (كاش)</option>
                    <option value="VISA">فيزا</option>
                    <option value="INSTAPAY">إنستا باي</option>
                    <option value="VODAFONE_CASH">فودافون كاش</option>
                    <option value="DEFERRED">آجل (مديونية)</option>
                  </select>
                </div>
              </div>

              {/* Items Rows */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="block text-xs font-semibold text-gray-300">الخامات المشتراة</label>
                  <span className="text-[10px] text-gray-400">ادخل الكمية وإجمالي السعر وسيتم حساب سعر الوحدة تلقائياً</span>
                </div>

                {/* Column Headers */}
                <div className="grid grid-cols-12 gap-2 text-[11px] font-bold text-gray-400 px-2 py-1 bg-white/5 rounded-lg">
                  <div className="col-span-5">الخامة من المخزن</div>
                  <div className="col-span-3">الكمية</div>
                  <div className="col-span-3">إجمالي السعر (EGP)</div>
                  <div className="col-span-1 text-center">حذف</div>
                </div>

                {purItems.map((it, idx) => {
                  const selectedRm = rawMaterials.find((rm) => rm.id === it.rawMaterialId);
                  const qtyNum = parseFloat(it.quantity) || 0;
                  const totNum = parseFloat(it.totalPrice) || 0;
                  const unitPriceCalculated = qtyNum > 0 && totNum > 0 ? (totNum / qtyNum).toFixed(2) : null;

                  return (
                    <div key={idx} className="bg-slate-900/60 p-2.5 rounded-xl border border-white/5 space-y-1">
                      <div className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-5">
                          <select
                            value={it.rawMaterialId}
                            onChange={(e) => {
                              const val = e.target.value;
                              setPurItems((prev) => prev.map((p, i) => (i === idx ? { ...p, rawMaterialId: val } : p)));
                            }}
                            className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right focus:border-cyan-500"
                          >
                            <option value="">اختار الخامة من المخزن...</option>
                            {rawMaterials.map((rm) => (
                              <option key={rm.id} value={rm.id}>
                                {rm.name} ({rm.purchaseUnit})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-3">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            placeholder="الكمية"
                            value={it.quantity}
                            onChange={(e) => {
                              const val = e.target.value;
                              setPurItems((prev) => prev.map((p, i) => (i === idx ? { ...p, quantity: val } : p)));
                            }}
                            className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                          />
                        </div>
                        <div className="col-span-3">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            placeholder="إجمالي السعر"
                            value={it.totalPrice}
                            onChange={(e) => {
                              const val = e.target.value;
                              setPurItems((prev) => prev.map((p, i) => (i === idx ? { ...p, totalPrice: val } : p)));
                            }}
                            className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                          />
                        </div>
                        <div className="col-span-1 text-center">
                          <button
                            type="button"
                            onClick={() => setPurItems((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-rose-400 hover:text-rose-300 p-1"
                            title="حذف هذا الصنف"
                          >
                            <Trash2 className="w-4 h-4 mx-auto" />
                          </button>
                        </div>
                      </div>

                      {/* Helper Unit Price Tag */}
                      {unitPriceCalculated && (
                        <div className="text-[10px] text-cyan-400 font-medium px-1 flex items-center gap-1">
                          <span>✓ سعر الوحدة المحسوب:</span>
                          <span className="font-mono font-bold">{unitPriceCalculated} EGP</span>
                          <span>لكل {selectedRm?.purchaseUnit || 'وحدة'}</span>
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => setPurItems((prev) => [...prev, { rawMaterialId: '', itemName: '', quantity: '', purchaseUnit: 'kg', totalPrice: '' }])}
                    className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    <span>إضافة صنف إضافي للفاتورة</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowAddMaterialModal(true)}
                    className="text-xs text-purple-400 hover:text-purple-300 font-semibold flex items-center gap-1 bg-purple-500/10 px-2.5 py-1 rounded-lg border border-purple-500/20"
                  >
                    <Package className="w-3.5 h-3.5" />
                    <span>+ خامة جديدة غير مسجلة بالمخزن</span>
                  </button>
                </div>
              </div>

              {/* Invoice Summary Box */}
              <div className="p-3 bg-gradient-to-r from-cyan-500/10 to-purple-500/10 border border-cyan-500/20 rounded-xl flex justify-between items-center">
                <span className="text-xs font-bold text-gray-300">إجمالي قيمة الفاتورة:</span>
                <span className="font-mono font-bold text-cyan-400 text-sm">
                  EGP {purItems.reduce((acc, it) => acc + (parseFloat(it.totalPrice) || 0), 0).toFixed(2)}
                </span>
              </div>

              <div>
                <label className="block text-xs text-gray-300 mb-1">المبلغ المدفوع فعلياً (اتركه فارغاً لاعتبار الفاتورة مسددة بالكامل كاش/فيزا)</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={purPaidAmount}
                  onChange={(e) => setPurPaidAmount(e.target.value)}
                  placeholder="المبلغ المدفوع (اختياري في حالة السداد الجزئي)"
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right placeholder-gray-500"
                />
              </div>

              <button type="submit" className="w-full py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-cyan-500/20">
                حفظ فاتورة المشتريات وتحديث رصيد المخزن
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODALS: Add Raw Material */}
      {showAddMaterialModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddMaterialModal(false)}>
          <div className="w-full max-w-lg glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowAddMaterialModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2">
              <PlusCircle className="w-5 h-5 text-cyan-400" />
              <span>إضافة خامة / مادة خام جديدة للمخزن</span>
            </h3>
            <p className="text-xs text-gray-400 mb-4">أدخل بيانات الخامة ووحدات القياس لتتبع المخزون وحساب تكلفة الوصفات</p>

            <form onSubmit={handleAddRawMaterial} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-300 mb-1">اسم الخامة / المادة الخام *</label>
                <input
                  required
                  type="text"
                  value={newMatName}
                  onChange={(e) => setNewMatName(e.target.value)}
                  placeholder="مثال: بن كولومبي، سيرب كراميل، شيكولاتة نوتيلا..."
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                />
              </div>

              {/* Units & Conversion Row */}
              <div className="grid grid-cols-3 gap-2 bg-slate-900/60 p-3 rounded-xl border border-white/5">
                <div>
                  <label className="block text-[11px] text-gray-300 mb-1">وحدة الشراء (بالفاتورة)</label>
                  <input
                    required
                    type="text"
                    value={newMatPurchaseUnit}
                    onChange={(e) => setNewMatPurchaseUnit(e.target.value)}
                    placeholder="مثال: kg أو liter أو box"
                    className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-300 mb-1">وحدة الخصم (بالوصفة)</label>
                  <input
                    required
                    type="text"
                    value={newMatDeductUnit}
                    onChange={(e) => setNewMatDeductUnit(e.target.value)}
                    placeholder="مثال: g أو ml أو unit"
                    className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-300 mb-1">معامل التحويل</label>
                  <input
                    required
                    type="number"
                    step="any"
                    min="0.001"
                    value={newMatConversion}
                    onChange={(e) => setNewMatConversion(e.target.value)}
                    placeholder="1000"
                    className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right"
                  />
                </div>
                <div className="col-span-3 text-[10px] text-gray-400 pt-1">
                  💡 تلميح: 1 {newMatPurchaseUnit || 'وحدة شراء'} = {newMatConversion || '1000'} {newMatDeductUnit || 'وحدة خصم'}
                </div>
              </div>

              {/* Stock & Cost Row */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs text-gray-300 mb-1">الرصيد الافتتاحي</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={newMatStockQty}
                    onChange={(e) => setNewMatStockQty(e.target.value)}
                    placeholder={`0 (${newMatDeductUnit})`}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right placeholder-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">حد تنبيه النواقص</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={newMatMinStock}
                    onChange={(e) => setNewMatMinStock(e.target.value)}
                    placeholder={`0 (${newMatDeductUnit})`}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right placeholder-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">سعر تكلفة الشراء EGP</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={newMatCost}
                    onChange={(e) => setNewMatCost(e.target.value)}
                    placeholder={`لكل ${newMatPurchaseUnit}`}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right placeholder-gray-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-cyan-500/20 hover:from-cyan-600 hover:to-purple-700 mt-2"
              >
                حفظ الخامة الجديدة في المخزن
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODALS: Edit Raw Material */}
      {showEditMaterialModal && selectedMaterialToEdit && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowEditMaterialModal(false)}>
          <div className="w-full max-w-lg glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowEditMaterialModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2">
              <Pencil className="w-5 h-5 text-cyan-400" />
              <span>تعديل بيانات الخامة / المادة الخام</span>
            </h3>
            <p className="text-xs text-gray-400 mb-4">تعديل الاسم، وحدات القياس، معامل التحويل، الرصيد وسعر تكلفة الشراء</p>

            <form onSubmit={handleEditRawMaterial} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-300 mb-1">اسم الخامة *</label>
                <input
                  required
                  type="text"
                  value={editMatName}
                  onChange={(e) => setEditMatName(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right focus:border-cyan-500"
                />
              </div>

              {/* Units & Conversion Row */}
              <div className="grid grid-cols-3 gap-2 bg-slate-900/60 p-3 rounded-xl border border-white/5">
                <div>
                  <label className="block text-[11px] text-gray-300 mb-1">وحدة الشراء (الفاتورة)</label>
                  <input
                    required
                    type="text"
                    value={editMatPurchaseUnit}
                    onChange={(e) => setEditMatPurchaseUnit(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-300 mb-1">وحدة الخصم (الوصفة)</label>
                  <input
                    required
                    type="text"
                    value={editMatDeductUnit}
                    onChange={(e) => setEditMatDeductUnit(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-300 mb-1">معامل التحويل</label>
                  <input
                    required
                    type="number"
                    step="any"
                    min="0.001"
                    value={editMatConversion}
                    onChange={(e) => setEditMatConversion(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-lg p-2 text-xs text-white text-right"
                  />
                </div>
                <div className="col-span-3 text-[10px] text-gray-400 pt-1">
                  💡 1 {editMatPurchaseUnit || 'وحدة شراء'} = {editMatConversion || '1000'} {editMatDeductUnit || 'وحدة خصم'}
                </div>
              </div>

              {/* Stock & Cost Row */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs text-gray-300 mb-1">الرصيد بالمخزن ({editMatDeductUnit})</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={editMatStockQty}
                    onChange={(e) => setEditMatStockQty(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">حد التنبيه ({editMatDeductUnit})</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={editMatMinStock}
                    onChange={(e) => setEditMatMinStock(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">سعر الشراء EGP</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={editMatCost}
                    onChange={(e) => setEditMatCost(e.target.value)}
                    placeholder={`لكل ${editMatPurchaseUnit}`}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right"
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEditMaterialModal(false)}
                  className="w-1/3 py-2.5 rounded-xl border border-white/10 text-gray-300 hover:bg-white/5 text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="w-2/3 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-cyan-500/20 hover:from-cyan-600 hover:to-purple-700 active:scale-95 transition-all"
                >
                  حفظ التعديلات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODALS: Add Menu Item with Pricing Calculator & Optional Recipe */}
      {showAddItemModal && (() => {
        const c = parseFloat(newItemCost) || 0;
        const p = parseFloat(newItemPrice) || 0;
        const profit = p - c;
        const margin = p > 0 ? (profit / p) * 100 : 0;

        return (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddItemModal(false)}>
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowAddItemModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-emerald-400" />
                <span>إضافة صنف جديد للمنيو وحاسبة التسعير والربح</span>
              </h3>
              <p className="text-xs text-gray-400 mb-4">
                أدخل اسم الصنف والتكلفة وسعر البيع، وسيحسب النظام هامش الربح وصافي المكسب تلقائياً
              </p>

              <form onSubmit={handleCreateMenuItem} className="space-y-4">
                {/* Basic Item Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">اسم الصنف *</label>
                    <input
                      required
                      type="text"
                      value={newItemName}
                      onChange={(e) => setNewItemName(e.target.value)}
                      placeholder="مثال: فلات وايت، موكا مثلج، ريد بول..."
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">القسم / التصنيف *</label>
                    <input
                      required
                      type="text"
                      list="add-item-categories-list"
                      value={newItemCategory}
                      onChange={(e) => setNewItemCategory(e.target.value)}
                      placeholder="اختر أو اكتب قسماً جديداً..."
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                    />
                    <datalist id="add-item-categories-list">
                      {existingCategories.map((cat) => (
                        <option key={cat} value={cat} />
                      ))}
                    </datalist>
                  </div>
                </div>

                {/* Core Pricing & Profitability Trio (Cost, Price, Margin) */}
                <div className="bg-slate-900/90 p-4 rounded-2xl border border-white/10 space-y-3 shadow-inner">
                  <div className="flex items-center gap-1.5">
                    <DollarSign className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-white">حاسبة التسعير والربح التلقائية</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* 1. Cost */}
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">
                        سعر التكلفة EGP
                        <span className="text-[10px] text-gray-400 mr-1">(تكلفة التحضير/الشراء)</span>
                      </label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={newItemCost}
                        onChange={(e) => handleNewCostChange(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-950 border border-amber-500/30 rounded-xl p-2.5 text-xs text-amber-300 font-mono text-right placeholder-gray-600 focus:border-amber-400 font-semibold"
                      />
                    </div>

                    {/* 2. Price */}
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">
                        سعر البيع EGP *
                        <span className="text-[10px] text-gray-400 mr-1">(سعر البيع للزبون)</span>
                      </label>
                      <input
                        required
                        type="number"
                        step="any"
                        min="0"
                        value={newItemPrice}
                        onChange={(e) => handleNewPriceChange(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-950 border border-cyan-500/30 rounded-xl p-2.5 text-xs text-cyan-300 font-mono text-right placeholder-gray-600 focus:border-cyan-400 font-bold"
                      />
                    </div>

                    {/* 3. Margin % */}
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">
                        نسبة هامش الربح %
                        <span className="text-[10px] text-gray-400 mr-1">(نسبة المكسب)</span>
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          step="any"
                          value={newItemMargin}
                          onChange={(e) => handleNewMarginChange(e.target.value)}
                          placeholder="0.0"
                          className="w-full bg-slate-950 border border-purple-500/30 rounded-xl p-2.5 pr-8 text-xs text-purple-300 font-mono text-right placeholder-gray-600 focus:border-purple-400 font-semibold"
                        />
                        <span className="absolute left-3 top-2.5 text-xs text-gray-400 font-mono">%</span>
                      </div>
                    </div>
                  </div>

                  {/* Realtime KPI Banner */}
                  <div className="flex flex-col sm:flex-row items-center justify-between bg-slate-950 p-2.5 px-4 rounded-xl border border-white/5 text-xs gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">صافي المكسب للقطعة:</span>
                      <span className={`font-mono font-bold text-sm ${profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        EGP {profit.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">نسبة الربحية الإجمالية:</span>
                      <span className={`font-mono font-bold text-sm ${margin >= 30 ? 'text-emerald-300' : margin >= 15 ? 'text-amber-300' : 'text-rose-400'}`}>
                        {margin.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Optional Recipe Section */}
                <div className="bg-slate-900/60 rounded-2xl p-4 border border-white/5 space-y-3">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Package className="w-4 h-4 text-purple-400" />
                        <span>مكونات الوصفة وخصم الخامات من المخزن (اختياري)</span>
                      </h4>
                      <p className="text-[11px] text-gray-400">
                        إذا كان المنتج مشروباً أو وجبة تود خصم خاماتها تلقائياً عند البيع
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowNewItemRecipeSection(!showNewItemRecipeSection)}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-[11px] font-semibold border border-white/10 transition-all"
                      >
                        {showNewItemRecipeSection ? 'إخفاء الخامات ▲' : 'إظهار مقادير الخامات ▼'}
                      </button>
                      {showNewItemRecipeSection && (
                        <button
                          type="button"
                          onClick={() => setNewItemIngredients([...newItemIngredients, { rawMaterialId: '', quantity: '', customUnitCost: '' }])}
                          className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[11px] font-bold hover:bg-purple-500/30 flex items-center gap-1 transition-all"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>+ إضافة خامة</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {showNewItemRecipeSection && (
                    <div className="space-y-3 pt-2">
                      {newItemIngredients.length === 0 ? (
                        <div className="text-center py-4 border border-dashed border-white/10 rounded-xl text-gray-500 text-xs">
                          لا توجد خامات مضافة للوصفة. اضغط على &quot;+ إضافة خامة&quot; لاختيار خامات من المخزن، أو يمكنك حفظ الصنف مباشرة بالتكلفة المحددة أعلاه.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                          {newItemIngredients.map((ing, idx) => {
                            const mat = rawMaterials.find((m) => m.id === ing.rawMaterialId);
                            const defaultCostPerDeduct = mat && mat.conversionFactor > 0 ? (mat.costPerPurchaseUnit || 0) / mat.conversionFactor : 0;
                            const effectiveUnitCost = ing.customUnitCost !== undefined && ing.customUnitCost !== ''
                              ? parseFloat(ing.customUnitCost) || 0
                              : defaultCostPerDeduct;
                            const rowCost = effectiveUnitCost * (parseFloat(ing.quantity) || 0);

                            return (
                              <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2.5 rounded-xl border border-white/5 text-xs">
                                <div className="flex-1 min-w-[180px]">
                                  <select
                                    required
                                    value={ing.rawMaterialId}
                                    onChange={(e) => {
                                      const updated = [...newItemIngredients];
                                      const newMatId = e.target.value;
                                      updated[idx].rawMaterialId = newMatId;
                                      const selectedMat = rawMaterials.find((m) => m.id === newMatId);
                                      const uCost = selectedMat && selectedMat.conversionFactor > 0 ? (selectedMat.costPerPurchaseUnit || 0) / selectedMat.conversionFactor : 0;
                                      updated[idx].customUnitCost = uCost > 0 ? uCost.toFixed(3) : '';
                                      setNewItemIngredients(updated);
                                    }}
                                    className="w-full bg-slate-800 border border-white/10 rounded-lg p-1.5 text-xs text-white text-right"
                                  >
                                    <option value="">-- اختر الخامة من المخزن --</option>
                                    {rawMaterials.map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.name} ({m.deductUnit})
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                {/* Quantity Input */}
                                <div className="w-28 flex items-center gap-1 bg-slate-800 border border-white/10 rounded-lg px-2 py-1">
                                  <input
                                    required
                                    type="number"
                                    step="any"
                                    min="0.001"
                                    placeholder="الكمية"
                                    value={ing.quantity}
                                    onChange={(e) => {
                                      const updated = [...newItemIngredients];
                                      updated[idx].quantity = e.target.value;
                                      setNewItemIngredients(updated);
                                    }}
                                    className="w-full bg-transparent text-xs text-white text-right outline-none font-mono"
                                  />
                                  <span className="text-[10px] text-gray-400 font-mono whitespace-nowrap">
                                    {mat?.deductUnit || ''}
                                  </span>
                                </div>

                                {/* Editable Unit Cost */}
                                <div className="w-32 flex items-center gap-1 bg-slate-800 border border-white/10 rounded-lg px-2 py-1" title="سعر الوحدة من هذه الخامة (يمكنك تعديله يدوياً إذا رغبت)">
                                  <span className="text-[10px] text-gray-400 font-mono">سعر/{mat?.deductUnit || 'وحدة'}:</span>
                                  <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    placeholder={defaultCostPerDeduct.toFixed(3)}
                                    value={ing.customUnitCost !== undefined && ing.customUnitCost !== '' ? ing.customUnitCost : (defaultCostPerDeduct > 0 ? defaultCostPerDeduct.toFixed(3) : '')}
                                    onChange={(e) => {
                                      const updated = [...newItemIngredients];
                                      updated[idx].customUnitCost = e.target.value;
                                      setNewItemIngredients(updated);
                                    }}
                                    className="w-full bg-transparent text-xs text-amber-300 text-right outline-none font-mono"
                                  />
                                </div>

                                <div className="w-20 text-left font-mono text-xs text-amber-300 whitespace-nowrap">
                                  EGP {rowCost.toFixed(2)}
                                </div>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setNewItemIngredients(newItemIngredients.filter((_, i) => i !== idx));
                                  }}
                                  className="p-1 rounded-lg text-rose-400 hover:bg-rose-500/10 hover:text-white"
                                  title="حذف الخامة من الوصفة"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Recipe Cost Footer & Apply Button */}
                      {(() => {
                        const recipeTotal = newItemIngredients.reduce((sum, ing) => {
                          const mat = rawMaterials.find((m) => m.id === ing.rawMaterialId);
                          const defaultCostPerDeduct = mat && mat.conversionFactor > 0 ? (mat.costPerPurchaseUnit || 0) / mat.conversionFactor : 0;
                          const effectiveUnitCost = ing.customUnitCost !== undefined && ing.customUnitCost !== ''
                            ? parseFloat(ing.customUnitCost) || 0
                            : defaultCostPerDeduct;
                          return sum + effectiveUnitCost * (parseFloat(ing.quantity) || 0);
                        }, 0);

                        return (
                          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 p-3 bg-slate-900/90 rounded-xl border border-purple-500/20 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-400">إجمالي تكلفة مقادير الوصفة:</span>
                              <span className="text-sm font-bold font-mono text-amber-400">
                                EGP {recipeTotal.toFixed(2)}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                handleNewCostChange(recipeTotal.toFixed(2));
                                triggerAlert('success', `تم تطبيق تكلفة الوصفة (EGP ${recipeTotal.toFixed(2)}) في خانة التكلفة!`);
                              }}
                              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold hover:from-amber-600 hover:to-orange-600 text-[11px] shadow-sm flex items-center gap-1 active:scale-95 transition-all"
                            >
                              <span>اعتماد تكلفة الوصفة في خانة التكلفة أعلاه ⬆️</span>
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddItemModal(false)}
                    className="w-1/3 py-2.5 rounded-xl border border-white/10 text-gray-300 hover:bg-white/5 text-xs font-semibold"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    className="w-2/3 py-2.5 bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-500/20 hover:from-emerald-600 hover:to-cyan-600 active:scale-95 transition-all"
                  >
                    حفظ وإضافة الصنف للمنيو
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* MODALS: Edit Menu Item with Pricing Calculator & Optional Recipe */}
      {showEditItemModal && selectedItemToEdit && (() => {
        const c = parseFloat(editItemCost) || 0;
        const p = parseFloat(editItemPrice) || 0;
        const profit = p - c;
        const margin = p > 0 ? (profit / p) * 100 : 0;

        return (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowEditItemModal(false)}>
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowEditItemModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2">
                <Pencil className="w-5 h-5 text-cyan-400" />
                <span>تعديل الصنف والتسعير ومقادير الوصفة</span>
              </h3>
              <p className="text-xs text-gray-400 mb-4">
                تعديل اسم الصنف والتكلفة وسعر البيع ونسبة الربح أو تعديل مقادير الوصفة من المخزن
              </p>

              <form onSubmit={handleUpdateMenuItem} className="space-y-4">
                {/* Basic Item Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">اسم الصنف *</label>
                    <input
                      required
                      type="text"
                      value={editItemName}
                      onChange={(e) => setEditItemName(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right focus:border-cyan-500 font-semibold"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">القسم / التصنيف *</label>
                    <input
                      required
                      type="text"
                      list="edit-item-categories-list"
                      value={editItemCategory}
                      onChange={(e) => setEditItemCategory(e.target.value)}
                      className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right focus:border-cyan-500"
                    />
                    <datalist id="edit-item-categories-list">
                      {existingCategories.map((cat) => (
                        <option key={cat} value={cat} />
                      ))}
                    </datalist>
                  </div>
                </div>

                {/* Core Pricing & Profitability Trio (Cost, Price, Margin) */}
                <div className="bg-slate-900/90 p-4 rounded-2xl border border-white/10 space-y-3 shadow-inner">
                  <div className="flex items-center gap-1.5">
                    <DollarSign className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-white">حاسبة التسعير والربح التلقائية</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* 1. Cost */}
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">
                        سعر التكلفة EGP
                        <span className="text-[10px] text-gray-400 mr-1">(تكلفة التحضير/الشراء)</span>
                      </label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={editItemCost}
                        onChange={(e) => handleEditCostChange(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-950 border border-amber-500/30 rounded-xl p-2.5 text-xs text-amber-300 font-mono text-right placeholder-gray-600 focus:border-amber-400 font-semibold"
                      />
                    </div>

                    {/* 2. Price */}
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">
                        سعر البيع EGP *
                        <span className="text-[10px] text-gray-400 mr-1">(سعر البيع للزبون)</span>
                      </label>
                      <input
                        required
                        type="number"
                        step="any"
                        min="0"
                        value={editItemPrice}
                        onChange={(e) => handleEditPriceChange(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-slate-950 border border-cyan-500/30 rounded-xl p-2.5 text-xs text-cyan-300 font-mono text-right placeholder-gray-600 focus:border-cyan-400 font-bold"
                      />
                    </div>

                    {/* 3. Margin % */}
                    <div>
                      <label className="block text-xs text-gray-300 mb-1">
                        نسبة هامش الربح %
                        <span className="text-[10px] text-gray-400 mr-1">(نسبة المكسب)</span>
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          step="any"
                          value={editItemMargin}
                          onChange={(e) => handleEditMarginChange(e.target.value)}
                          placeholder="0.0"
                          className="w-full bg-slate-950 border border-purple-500/30 rounded-xl p-2.5 pr-8 text-xs text-purple-300 font-mono text-right placeholder-gray-600 focus:border-purple-400 font-semibold"
                        />
                        <span className="absolute left-3 top-2.5 text-xs text-gray-400 font-mono">%</span>
                      </div>
                    </div>
                  </div>

                  {/* Realtime KPI Banner */}
                  <div className="flex flex-col sm:flex-row items-center justify-between bg-slate-950 p-2.5 px-4 rounded-xl border border-white/5 text-xs gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">صافي المكسب للقطعة:</span>
                      <span className={`font-mono font-bold text-sm ${profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        EGP {profit.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">نسبة الربحية الإجمالية:</span>
                      <span className={`font-mono font-bold text-sm ${margin >= 30 ? 'text-emerald-300' : margin >= 15 ? 'text-amber-300' : 'text-rose-400'}`}>
                        {margin.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Optional Recipe Section */}
                <div className="bg-slate-900/60 rounded-2xl p-4 border border-white/5 space-y-3">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Package className="w-4 h-4 text-purple-400" />
                        <span>مكونات الوصفة وخصم الخامات من المخزن (اختياري)</span>
                      </h4>
                      <p className="text-[11px] text-gray-400">
                        إذا كان المنتج مشروباً أو وجبة تود خصم خاماتها تلقائياً عند البيع
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowEditItemRecipeSection(!showEditItemRecipeSection)}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-[11px] font-semibold border border-white/10 transition-all"
                      >
                        {showEditItemRecipeSection ? 'إخفاء الخامات ▲' : 'إظهار مقادير الخامات ▼'}
                      </button>
                      {showEditItemRecipeSection && (
                        <button
                          type="button"
                          onClick={() => setEditItemIngredients([...editItemIngredients, { rawMaterialId: '', quantity: '', customUnitCost: '' }])}
                          className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[11px] font-bold hover:bg-purple-500/30 flex items-center gap-1 transition-all"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>+ إضافة خامة</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {showEditItemRecipeSection && (
                    <div className="space-y-3 pt-2">
                      {editItemIngredients.length === 0 ? (
                        <div className="text-center py-4 border border-dashed border-white/10 rounded-xl text-gray-500 text-xs">
                          لا توجد خامات مضافة للوصفة. اضغط على &quot;+ إضافة خامة&quot; لاختيار خامات من المخزن، أو يمكنك حفظ الصنف مباشرة بالتكلفة المحددة أعلاه.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                          {editItemIngredients.map((ing, idx) => {
                            const mat = rawMaterials.find((m) => m.id === ing.rawMaterialId);
                            const defaultCostPerDeduct = mat && mat.conversionFactor > 0 ? (mat.costPerPurchaseUnit || 0) / mat.conversionFactor : 0;
                            const effectiveUnitCost = ing.customUnitCost !== undefined && ing.customUnitCost !== ''
                              ? parseFloat(ing.customUnitCost) || 0
                              : defaultCostPerDeduct;
                            const rowCost = effectiveUnitCost * (parseFloat(ing.quantity) || 0);

                            return (
                              <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2.5 rounded-xl border border-white/5 text-xs">
                                <div className="flex-1 min-w-[180px]">
                                  <select
                                    required
                                    value={ing.rawMaterialId}
                                    onChange={(e) => {
                                      const updated = [...editItemIngredients];
                                      const newMatId = e.target.value;
                                      updated[idx].rawMaterialId = newMatId;
                                      const selectedMat = rawMaterials.find((m) => m.id === newMatId);
                                      const uCost = selectedMat && selectedMat.conversionFactor > 0 ? (selectedMat.costPerPurchaseUnit || 0) / selectedMat.conversionFactor : 0;
                                      updated[idx].customUnitCost = uCost > 0 ? uCost.toFixed(3) : '';
                                      setEditItemIngredients(updated);
                                    }}
                                    className="w-full bg-slate-800 border border-white/10 rounded-lg p-1.5 text-xs text-white text-right"
                                  >
                                    <option value="">-- اختر الخامة من المخزن --</option>
                                    {rawMaterials.map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.name} ({m.deductUnit})
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                {/* Quantity Input */}
                                <div className="w-28 flex items-center gap-1 bg-slate-800 border border-white/10 rounded-lg px-2 py-1">
                                  <input
                                    required
                                    type="number"
                                    step="any"
                                    min="0.001"
                                    placeholder="الكمية"
                                    value={ing.quantity}
                                    onChange={(e) => {
                                      const updated = [...editItemIngredients];
                                      updated[idx].quantity = e.target.value;
                                      setEditItemIngredients(updated);
                                    }}
                                    className="w-full bg-transparent text-xs text-white text-right outline-none font-mono"
                                  />
                                  <span className="text-[10px] text-gray-400 font-mono whitespace-nowrap">
                                    {mat?.deductUnit || ''}
                                  </span>
                                </div>

                                {/* Editable Unit Cost */}
                                <div className="w-32 flex items-center gap-1 bg-slate-800 border border-white/10 rounded-lg px-2 py-1" title="سعر الوحدة من هذه الخامة (يمكنك تعديله يدوياً إذا رغبت)">
                                  <span className="text-[10px] text-gray-400 font-mono">سعر/{mat?.deductUnit || 'وحدة'}:</span>
                                  <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    placeholder={defaultCostPerDeduct.toFixed(3)}
                                    value={ing.customUnitCost !== undefined && ing.customUnitCost !== '' ? ing.customUnitCost : (defaultCostPerDeduct > 0 ? defaultCostPerDeduct.toFixed(3) : '')}
                                    onChange={(e) => {
                                      const updated = [...editItemIngredients];
                                      updated[idx].customUnitCost = e.target.value;
                                      setEditItemIngredients(updated);
                                    }}
                                    className="w-full bg-transparent text-xs text-amber-300 text-right outline-none font-mono"
                                  />
                                </div>

                                <div className="w-20 text-left font-mono text-xs text-amber-300 whitespace-nowrap">
                                  EGP {rowCost.toFixed(2)}
                                </div>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditItemIngredients(editItemIngredients.filter((_, i) => i !== idx));
                                  }}
                                  className="p-1 rounded-lg text-rose-400 hover:bg-rose-500/10 hover:text-white"
                                  title="حذف الخامة من الوصفة"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Recipe Cost Footer & Apply Button */}
                      {(() => {
                        const recipeTotal = editItemIngredients.reduce((sum, ing) => {
                          const mat = rawMaterials.find((m) => m.id === ing.rawMaterialId);
                          const defaultCostPerDeduct = mat && mat.conversionFactor > 0 ? (mat.costPerPurchaseUnit || 0) / mat.conversionFactor : 0;
                          const effectiveUnitCost = ing.customUnitCost !== undefined && ing.customUnitCost !== ''
                            ? parseFloat(ing.customUnitCost) || 0
                            : defaultCostPerDeduct;
                          return sum + effectiveUnitCost * (parseFloat(ing.quantity) || 0);
                        }, 0);

                        return (
                          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 p-3 bg-slate-900/90 rounded-xl border border-purple-500/20 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-400">إجمالي تكلفة مقادير الوصفة:</span>
                              <span className="text-sm font-bold font-mono text-amber-400">
                                EGP {recipeTotal.toFixed(2)}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                handleEditCostChange(recipeTotal.toFixed(2));
                                triggerAlert('success', `تم تطبيق تكلفة الوصفة (EGP ${recipeTotal.toFixed(2)}) في خانة التكلفة!`);
                              }}
                              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold hover:from-amber-600 hover:to-orange-600 text-[11px] shadow-sm flex items-center gap-1 active:scale-95 transition-all"
                            >
                              <span>اعتماد تكلفة الوصفة في خانة التكلفة أعلاه ⬆️</span>
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowEditItemModal(false)}
                    className="w-1/3 py-2.5 rounded-xl border border-white/10 text-gray-300 hover:bg-white/5 text-xs font-semibold"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    className="w-2/3 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-cyan-500/20 hover:from-cyan-600 hover:to-purple-700 active:scale-95 transition-all"
                  >
                    حفظ التعديلات
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* MODALS: Settle Invoice Payment */}
      {showPayModal && selectedInvoiceToPay && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowPayModal(false)}>
          <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowPayModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-emerald-400" />
              <span>تسديد دفعة / مديونية فاتورة</span>
            </h3>
            <p className="text-xs text-gray-400 mb-4">فاتورة رقم: <span className="font-mono font-bold text-white">{selectedInvoiceToPay.invoiceNumber}</span> | المورد: <span className="text-cyan-300 font-bold">{selectedInvoiceToPay.supplier?.name || selectedInvoiceToPay.supplierName || 'مورد عام'}</span></p>

            {/* Financial Status Banner */}
            <div className="grid grid-cols-3 gap-2 bg-slate-900/80 p-3 rounded-xl border border-white/5 text-center mb-4">
              <div>
                <span className="text-[10px] text-gray-400 block">إجمالي الفاتورة</span>
                <span className="text-xs font-bold text-white font-mono mt-0.5 block">EGP {selectedInvoiceToPay.totalAmount.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 block">المدفوع سابقاً</span>
                <span className="text-xs font-bold text-emerald-400 font-mono mt-0.5 block">EGP {selectedInvoiceToPay.paidAmount.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-[10px] text-gray-400 block">المتبقي حالياً</span>
                <span className="text-xs font-bold text-rose-400 font-mono mt-0.5 block">EGP {selectedInvoiceToPay.remainingAmount.toFixed(2)}</span>
              </div>
            </div>

            <form onSubmit={handleSettlePayment} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-300 mb-1">المبلغ المراد سداده الآن (EGP) *</label>
                <input
                  required
                  type="number"
                  min="1"
                  max={selectedInvoiceToPay.remainingAmount}
                  step="any"
                  value={paymentAmountInput}
                  onChange={(e) => setPaymentAmountInput(e.target.value)}
                  placeholder="ادخل مبلغ السداد"
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right placeholder-gray-500 focus:border-emerald-500"
                />
                <div className="flex justify-between items-center text-[10px] text-gray-400 mt-1 px-1">
                  <span>المبلغ المتبقي بعد هذا السداد:</span>
                  <span className="font-mono font-bold text-cyan-400">
                    EGP {Math.max(0, selectedInvoiceToPay.remainingAmount - (parseFloat(paymentAmountInput) || 0)).toFixed(2)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-300 mb-1">طريقة السداد</label>
                <select
                  value={paymentMethodInput}
                  onChange={(e) => setPaymentMethodInput(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-2.5 text-xs text-white text-right"
                >
                  <option value="CASH">نقدي (كاش من الدرج)</option>
                  <option value="VISA">فيزا / بنك</option>
                  <option value="INSTAPAY">إنستا باي</option>
                  <option value="VODAFONE_CASH">فودافون كاش</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-300 mb-1">ملاحظات السداد (اختياري)</label>
                <input
                  type="text"
                  value={paymentNotesInput}
                  onChange={(e) => setPaymentNotesInput(e.target.value)}
                  placeholder="مثال: تحويل إنستاباي دفعة ثانية، إيصال رقم..."
                  className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right placeholder-gray-500"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-500/20 hover:from-emerald-600 hover:to-teal-700 mt-2"
              >
                تأكيد تسجيل السداد وتحديث الحساب
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODALS: Add Customer */}
      {showAddCustModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddCustModal(false)}>
          <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowAddCustModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            <h3 className="text-base font-bold text-white mb-3">إضافة عميل جديد وفئة الخصم</h3>
            <form onSubmit={handleAddCustomer} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-300 mb-1">اسم العميل / المؤسسة</label>
                <input required type="text" value={newCustName} onChange={(e) => setNewCustName(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="مثال: د. مايكل / مستشفى الأمل" />
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">رقم الهاتف</label>
                <input type="text" value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="01xxxxxxxxx" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-300 mb-1">فئة العميل</label>
                  <select value={newCustType} onChange={(e) => setNewCustType(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right">
                    <option value="INDIVIDUAL">زبون مميز</option>
                    <option value="COMPANY">شركة / مؤسسة</option>
                    <option value="HOSPITAL">مستشفى / أطباء</option>
                    <option value="CAFE">كافيه / مطعم</option>
                    <option value="OTHER">أخرى</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">نسبة الخصم %</label>
                  <input type="number" min="0" max="100" value={newCustDiscount} onChange={(e) => setNewCustDiscount(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="15" />
                </div>
              </div>
              <button type="submit" className="w-full py-2.5 bg-gradient-to-r from-cyan-500 to-purple-600 text-white font-bold rounded-xl text-xs mt-2">
                حفظ العميل
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODALS: Add Wastage */}
      {showAddWastageModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddWastageModal(false)}>
          <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowAddWastageModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            <h3 className="text-base font-bold text-white mb-3">تسجيل هالك وتلفيات مخزن</h3>
            <form onSubmit={handleAddWastage} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-300 mb-1">المادة الخام</label>
                <select required value={wastageMatId} onChange={(e) => setWastageMatId(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right">
                  <option value="">اختار الخامة...</option>
                  {rawMaterials.map((rm) => (
                    <option key={rm.id} value={rm.id}>{rm.name} ({rm.deductUnit})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">الكمية التالفة (بوحدة الصرف {rawMaterials.find(m => m.id === wastageMatId)?.deductUnit || ''})</label>
                <input required type="number" step="any" min="0" value={wastageQty} onChange={(e) => setWastageQty(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right" placeholder="مثال: 250" />
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">سبب الهدر / التلف</label>
                <select value={wastageReason} onChange={(e) => setWastageReason(e.target.value)} className="w-full bg-slate-900 border border-white/10 rounded-xl p-2 text-xs text-white text-right">
                  <option value="هدر تحضير">هدر تحضير</option>
                  <option value="انتهاء صلاحية">انتهاء صلاحية</option>
                  <option value="سكب أو كسر">سكب أو كسر</option>
                  <option value="تلف تخزين">تلف في التخزين</option>
                  <option value="أخرى">أخرى</option>
                </select>
              </div>
              <button type="submit" className="w-full py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs mt-2">
                تأكيد تسجيل الهالك
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ADD ADMIN EXPENSE MODAL */}
      {showAddAdminExpenseModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowAddAdminExpenseModal(false)}>
          <div className="w-full max-w-md glass-panel rounded-2xl p-6 relative text-right" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowAddAdminExpenseModal(false)} className="absolute top-4 left-4 text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-base font-bold text-white mb-1">تسجيل مصروف إداري جديد</h3>
            <p className="text-xs text-gray-400 mb-4">يتم ربط المصروف بالوردية الحالية وخصمه من الكاش.</p>

            <form onSubmit={handleAddAdminExpense} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">مبلغ المصروف (ج.م) *</label>
                <input
                  type="number"
                  step="any"
                  min="0.01"
                  required
                  autoFocus
                  value={adminExpenseAmount}
                  onChange={(e) => setAdminExpenseAmount(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl py-2.5 px-3 text-white text-base text-right font-mono focus:border-amber-500"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">بيان وسبب المصروف *</label>
                <input
                  type="text"
                  required
                  value={adminExpenseReason}
                  onChange={(e) => setAdminExpenseReason(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl py-2.5 px-3 text-white text-xs text-right focus:border-amber-500"
                  placeholder="مثال: فواتير كهرباء، صيانة ماكينة، مستلزمات..."
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddAdminExpenseModal(false)}
                  className="py-2.5 border border-white/10 text-white rounded-xl text-xs hover:bg-white/5 transition-all"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={submittingAdminExpense}
                  className="py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-500/20 transition-all disabled:opacity-50"
                >
                  {submittingAdminExpense ? 'جاري الحفظ...' : 'تسجيل المصروف'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PERIOD INVOICES DRILLDOWN MODAL */}
      {selectedPeriod && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-md"
          onClick={() => setSelectedPeriod(null)}
        >
          <div
            className="w-full max-w-5xl glass-panel rounded-2xl p-6 relative text-right max-h-[90vh] flex flex-col"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-white/10 pb-4 mb-4 shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                    {selectedPeriod.type === 'day' ? <Calendar className="w-4 h-4" /> : <BarChart3 className="w-4 h-4" />}
                  </span>
                  <h3 className="text-base font-bold text-white">
                    فواتير مبيعات: {selectedPeriod.title}
                  </h3>
                  <span className="text-xs text-gray-400 font-mono">({selectedPeriod.key})</span>
                </div>
                {periodSummary && (
                  <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
                    <span className="text-gray-300">
                      عدد الفواتير: <strong className="text-cyan-400 font-mono">{periodSummary.ordersCount}</strong>
                    </span>
                    <span className="text-gray-500">•</span>
                    <span className="text-gray-300">
                      صافي الإيراد: <strong className="text-emerald-400 font-mono">EGP {periodSummary.totalNet.toFixed(2)}</strong>
                    </span>
                    <span className="text-gray-500">•</span>
                    <span className="text-gray-300">
                      متوسط الفاتورة: <strong className="text-purple-400 font-mono">EGP {periodSummary.avgTicket.toFixed(2)}</strong>
                    </span>
                    {periodSummary.totalDiscounts > 0 && (
                      <>
                        <span className="text-gray-500">•</span>
                        <span className="text-gray-300">
                          الخصومات: <strong className="text-amber-400 font-mono">EGP {periodSummary.totalDiscounts.toFixed(2)}</strong>
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => setSelectedPeriod(null)}
                className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filter / Search Row */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-4 shrink-0">
              <div className="flex items-center gap-2 w-full sm:w-auto flex-1 max-w-md">
                <input
                  type="text"
                  value={ordersSearch}
                  onChange={(e) => setOrdersSearch(e.target.value)}
                  placeholder="بحث برقم الفاتورة، الكاشير، الصنف، العميل..."
                  className="w-full bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-xs text-white text-right placeholder-gray-500 focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <label className="text-xs text-gray-400 shrink-0">طريقة الدفع:</label>
                <select
                  value={ordersFilterPayment}
                  onChange={(e) => setOrdersFilterPayment(e.target.value)}
                  className="bg-slate-900 border border-white/10 rounded-xl py-2 px-3 text-xs text-white text-right"
                >
                  <option value="ALL">جميع طرق الدفع</option>
                  <option value="CASH">نقدي (كاش)</option>
                  <option value="VISA">فيزا (Visa)</option>
                  <option value="INSTAPAY">إنستا باي (InstaPay)</option>
                  <option value="VODAFONE_CASH">فودافون كاش</option>
                  <option value="CASH_OUT">سحب كاش بالفيزا</option>
                </select>
                <span className="text-xs text-gray-400 mr-2">
                  المعروض: {filteredPeriodOrders.length}
                </span>
              </div>
            </div>

            {/* Orders Table */}
            <div className="flex-1 overflow-y-auto rounded-xl border border-white/5">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-900/90 text-gray-400 border-b border-white/5 sticky top-0 backdrop-blur-sm z-10">
                  <tr>
                    <th className="p-3">رقم الفاتورة</th>
                    <th className="p-3">الوقت</th>
                    <th className="p-3">الكاشير</th>
                    <th className="p-3">النوع / الطاولة</th>
                    <th className="p-3">طريقة الدفع</th>
                    <th className="p-3">الأصناف المطلوبة</th>
                    <th className="p-3">الإجمالي</th>
                    <th className="p-3 text-center">الإيصال</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {loadingPeriodOrders ? (
                    <tr>
                      <td colSpan={8}>
                        <NeonSpinner label="جاري تحميل فواتير الفترة..." />
                      </td>
                    </tr>
                  ) : filteredPeriodOrders.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-10 text-center text-gray-500">
                        لا توجد فواتير مطابقة للبحث.
                      </td>
                    </tr>
                  ) : (
                    filteredPeriodOrders.map((order) => {
                      const orderTime = new Date(order.createdAt).toLocaleTimeString('ar-EG', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true,
                      });
                      const itemsSummary = (order.items || [])
                        .map((i) => `${i.qty}× ${i.item?.name || 'صنف'}`)
                        .join('، ');

                      return (
                        <tr key={order.id} className="hover:bg-white/5 transition-colors">
                          <td className="p-3">
                            <span className="font-mono font-bold text-cyan-400 text-xs block">
                              {order.receiptNumber || `#${order.id.slice(0, 8)}`}
                            </span>
                            {order.customer && (
                              <span className="text-[10px] text-gray-400 block">
                                عميل: {order.customer.name}
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-gray-300 font-mono text-[11px]">
                            {orderTime}
                          </td>
                          <td className="p-3">
                            <span className="text-white font-semibold block">
                              {order.shift?.cashierName || order.shift?.user?.name || 'كاشير'}
                            </span>
                            <span className="text-[10px] text-gray-500 block font-mono">
                              وردية #{order.shiftId.slice(0, 6)}
                            </span>
                          </td>
                          <td className="p-3">
                            {order.orderType === 'DINE_IN' ? (
                              <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 text-[10px] font-semibold">
                                صالة {order.table?.name ? `(${order.table.name})` : ''}
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px] font-semibold">
                                تيك أواي
                              </span>
                            )}
                          </td>
                          <td className="p-3">
                            {order.paymentMethod === 'CASH' && (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-bold">
                                💵 نقدي
                              </span>
                            )}
                            {order.paymentMethod === 'VISA' && (
                              <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 text-[10px] font-bold">
                                💳 فيزا
                              </span>
                            )}
                            {order.paymentMethod === 'INSTAPAY' && (
                              <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 text-[10px] font-bold">
                                📱 إنستا باي
                              </span>
                            )}
                            {order.paymentMethod === 'VODAFONE_CASH' && (
                              <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 text-[10px] font-bold">
                                🔴 فودافون كاش
                              </span>
                            )}
                            {order.paymentMethod === 'CASH_OUT' && (
                              <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 text-[10px] font-bold">
                                💸 سحب كاش بالفيزا
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-gray-300 max-w-xs truncate" title={itemsSummary}>
                            {itemsSummary || '—'}
                          </td>
                          <td className="p-3 font-mono">
                            <span className="font-bold text-emerald-400 text-sm block">
                              EGP {Number(order.total).toFixed(2)}
                            </span>
                            {order.discount > 0 && (
                              <span className="text-[10px] text-amber-400 block">
                                خصم: EGP {Number(order.discount).toFixed(2)}
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            <button
                              onClick={() => setSelectedOrderReceipt(order)}
                              className="px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold text-xs inline-flex items-center gap-1 transition-all"
                              title="عرض تفاصيل الإيصال والطباعة"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              <span>الإيصال</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* DETAILED RECEIPT / INVOICE MODAL */}
      {selectedOrderReceipt && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 backdrop-blur-md"
          onClick={() => setSelectedOrderReceipt(null)}
        >
          <div
            className="admin-receipt-print w-full max-w-md bg-white text-gray-900 rounded-2xl p-6 relative text-right shadow-2xl overflow-hidden font-sans"
            dir="rtl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header Brand */}
            <div className="text-center border-b border-dashed border-gray-300 pb-4 mb-4">
              <div className="w-16 h-16 mx-auto rounded-full overflow-hidden mb-2 border border-gray-200">
                <Image width={128} height={128} unoptimized loading="eager" src="/bon-logo.jpg" alt="BON el MOON" className="w-full h-full object-cover" />
              </div>
              <h2 className="font-black text-xl text-gray-900 tracking-wide">BON el MOON</h2>
              <p className="text-xs text-gray-500 font-semibold">إيصال مبيعات</p>
              <span className="inline-block mt-1 font-mono font-bold text-xs bg-gray-100 px-3 py-1 rounded-full text-gray-800 border border-gray-200">
                {selectedOrderReceipt.receiptNumber || `#${selectedOrderReceipt.id}`}
              </span>
            </div>

            {/* Info details */}
            <div className="grid grid-cols-2 gap-2 text-xs border-b border-dashed border-gray-300 pb-3 mb-3 text-gray-600">
              <div>
                <span className="text-gray-400 block text-[10px]">التاريخ والوقت:</span>
                <span className="font-semibold text-gray-800">
                  {new Date(selectedOrderReceipt.createdAt).toLocaleString('ar-EG', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">الكاشير:</span>
                <span className="font-semibold text-gray-800">
                  {selectedOrderReceipt.shift?.cashierName || selectedOrderReceipt.shift?.user?.name || 'كاشير'}
                </span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">نوع الطلب:</span>
                <span className="font-semibold text-gray-800">
                  {selectedOrderReceipt.orderType === 'DINE_IN'
                    ? `صالة ${selectedOrderReceipt.table?.name ? `- ${selectedOrderReceipt.table.name}` : ''}`
                    : 'تيك أواي (سفري)'}
                </span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">طريقة الدفع:</span>
                <span className="font-bold text-gray-900">
                  {selectedOrderReceipt.paymentMethod === 'CASH' && 'نقدي (كاش)'}
                  {selectedOrderReceipt.paymentMethod === 'VISA' && 'بطاقة فيزا (Visa)'}
                  {selectedOrderReceipt.paymentMethod === 'INSTAPAY' && 'إنستا باي (InstaPay)'}
                  {selectedOrderReceipt.paymentMethod === 'VODAFONE_CASH' && 'فودافون كاش'}
                  {selectedOrderReceipt.paymentMethod === 'CASH_OUT' && 'سحب كاش بالفيزا'}
                </span>
              </div>
              {selectedOrderReceipt.customer && (
                <div className="col-span-2 bg-gray-50 p-2 rounded-lg border border-gray-100">
                  <span className="text-[10px] text-gray-400 block">بيانات العميل:</span>
                  <span className="font-bold text-gray-800 text-xs">
                    {selectedOrderReceipt.customer.name} {selectedOrderReceipt.customer.phone ? `(${selectedOrderReceipt.customer.phone})` : ''}
                  </span>
                </div>
              )}
            </div>

            {/* Items Table */}
            <div className="space-y-2 border-b border-dashed border-gray-300 pb-3 mb-3 max-h-48 overflow-y-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-100 text-[11px]">
                    <th className="py-1">الصنف</th>
                    <th className="py-1 text-center">الكمية</th>
                    <th className="py-1 text-left">السعر</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {(selectedOrderReceipt.items || []).map((oi) => (
                    <tr key={oi.id} className="py-1">
                      <td className="py-1 font-semibold text-gray-800">
                        {oi.item?.name || 'صنف'}
                        {oi.modifiers && oi.modifiers.length > 0 && (
                          <span className="block text-[10px] text-gray-400">
                            + {oi.modifiers.map((m) => m.modifier?.name).join('، ')}
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-center font-mono font-bold text-gray-700">
                        {oi.qty}
                      </td>
                      <td className="py-1 text-left font-mono font-bold text-gray-900">
                        EGP {oi.totalPrice.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals Summary */}
            <div className="space-y-1.5 text-xs mb-5">
              <div className="flex justify-between text-gray-500">
                <span>المجموع الفرعي:</span>
                <span className="font-mono">EGP {Number(selectedOrderReceipt.subtotal || selectedOrderReceipt.total).toFixed(2)}</span>
              </div>
              {selectedOrderReceipt.discount > 0 && (
                <div className="flex justify-between text-amber-600 font-semibold">
                  <span>
                    الخصم {selectedOrderReceipt.discountReason ? `(${selectedOrderReceipt.discountReason})` : ''}:
                  </span>
                  <span className="font-mono">- EGP {Number(selectedOrderReceipt.discount).toFixed(2)}</span>
                </div>
              )}
              {selectedOrderReceipt.tax > 0 && (
                <div className="flex justify-between text-gray-500">
                  <span>الضريبة:</span>
                  <span className="font-mono">EGP {Number(selectedOrderReceipt.tax).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-black text-gray-900 border-t border-gray-300 pt-2">
                <span>الإجمالي النهائي:</span>
                <span className="font-mono text-emerald-600">EGP {Number(selectedOrderReceipt.total).toFixed(2)}</span>
              </div>
            </div>

            {/* Print & Close Buttons */}
            <div className="flex gap-2">
              <button
                onClick={() => printAdmin('receipt')}
                className="flex-1 py-2.5 bg-gray-900 hover:bg-black text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-md transition-all"
              >
                <Printer className="w-4 h-4" />
                <span>طباعة الإيصال</span>
              </button>
              <button
                onClick={() => setSelectedOrderReceipt(null)}
                className="px-4 py-2.5 border border-gray-300 hover:bg-gray-100 text-gray-700 font-bold rounded-xl text-xs transition-all"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Alert Banner */}
      {alertMsg && (
        <div dir="rtl" className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 w-[calc(100vw-2rem)] max-w-md p-3.5 rounded-xl shadow-2xl border text-xs flex items-center gap-2.5 flex-row-reverse ${
          alertMsg.type === 'success' ? 'bg-emerald-950 border-emerald-400/40 text-emerald-100' : 'bg-rose-950 border-rose-400/40 text-rose-100'
        }`}>
          {alertMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span className="font-semibold">{alertMsg.text}</span>
        </div>
      )}
    </div>
  );
}
