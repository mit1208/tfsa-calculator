/**
 * TFSA Penalty Calculator Logic
 */

// --- Constants & Types ---
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let transactions = [];
let chartInstance = null;

// --- DOM Elements ---
const inputs = {
    year: document.getElementById('calcYear'),
    startRoom: document.getElementById('startRoom'),
    txDate: document.getElementById('txDate'),
    txInstitution: document.getElementById('txInstitution'),
    txType: document.getElementById('txType'),
    txAmount: document.getElementById('txAmount'),
    addTxBtn: document.getElementById('addTxBtn'),
    addTxError: document.getElementById('addTxError'),
    txList: document.getElementById('txList'),
    txCount: document.getElementById('txCount')
};

const outputs = {
    totalPenalty: document.getElementById('totalPenalty'),
    peakExcess: document.getElementById('peakExcess'),
    monthsAffected: document.getElementById('monthsAffected'),
    remainingRoom: document.getElementById('remainingRoom'), // New UI element
    nextYearRoom: document.getElementById('nextYearRoom'),
    totalContributions: document.getElementById('totalContributions'),
    totalWithdrawals: document.getElementById('totalWithdrawals'),
    monthlyTableBody: document.getElementById('monthlyTableBody'),
    tableMaxExcess: document.getElementById('tableMaxExcess'),
    tableTotalPenalty: document.getElementById('tableTotalPenalty'),
    chartCanvas: document.getElementById('balanceChart')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Set default date to today or start of selected year
    const today = new Date().toISOString().split('T')[0];
    inputs.txDate.value = today;

    // Load from local storage if needed (Skipping for simple MVP to ensure fresh start)

    // Attach Listeners
    inputs.addTxBtn.addEventListener('click', addTransaction);
    inputs.year.addEventListener('change', recalculateAll);
    inputs.startRoom.addEventListener('input', recalculateAll);

    // Initial Render
    recalculateAll();

    // CSV Listener
    document.getElementById('csvInput').addEventListener('change', handleCsvUpload);
});

// --- CSV Import ---

function downloadTemplate() {
    const csvContent = "Date,Type,Amount,Institution\n2024-01-15,Contribution,5000,RBC\n2024-06-20,Withdrawal,2000,Tangerine";
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "tfsa_template.csv";
    a.click();
    window.URL.revokeObjectURL(url);
}

function handleCsvUpload(event) {
    const file = event.target.files[0];
    const errorEl = document.getElementById('csvError');
    errorEl.classList.add('hidden');

    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const text = e.target.result;
        processCsvData(text, errorEl);
        // Reset input so same file can be selected again if needed
        event.target.value = '';
    };
    reader.readAsText(file);
}

function processCsvData(text, errorEl) {
    const lines = text.split('\n');
    let addedCount = 0;
    let errors = [];

    // Skip header if present
    let startIndex = 0;
    if (lines[0].toLowerCase().includes('date')) {
        startIndex = 1;
    }

    // Regex for splitting CSV lines while respecting quotes
    // Matches: "quoted, string" OR unquoted_string
    const csvSplitRegex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;

    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cols = line.split(csvSplitRegex).map(c => c.trim().replace(/^"|"$/g, ''));

        if (cols.length < 3) {
            errors.push(`Line ${i + 1}: Invalid format`);
            continue;
        }

        let [dateRaw, typeRaw, amountRaw, institution] = cols;

        // Normalize Type
        let type = 'CONTRIBUTION';
        if (typeRaw && typeRaw.toLowerCase().includes('withdraw')) {
            type = 'WITHDRAWAL';
        }

        // Parse Amount (Handle "7,371.84" -> 7371.84)
        const amount = parseFloat(amountRaw.replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) {
            errors.push(`Line ${i + 1}: Invalid amount: ${amountRaw}`);
            continue;
        }

        // Parse Date
        // Handle "YYYY-MM-DD" AND "2 Jan 2025"
        let date = dateRaw;
        const isoRegex = /^\d{4}-\d{2}-\d{2}$/;

        if (!isoRegex.test(date)) {
            // Try parsing "2 Jan 2025"
            const parsedDate = new Date(dateRaw);
            if (!isNaN(parsedDate.getTime())) {
                // Convert to YYYY-MM-DD for consistency
                date = parsedDate.toISOString().split('T')[0];
            } else {
                errors.push(`Line ${i + 1}: Invalid date: ${dateRaw}`);
                continue;
            }
        }

        // Add
        transactions.push({
            id: Date.now() + Math.random(),
            date,
            type,
            amount,
            institution: institution || 'Imported'
        });
        addedCount++;
    }

    if (addedCount > 0) {
        renderTxList();
        recalculateAll();
        if (errors.length > 0) {
            errorEl.textContent = `Imported ${addedCount} items. Skipped ${errors.length} errors. Details: ${errors.join('; ')}`;
            errorEl.classList.remove('hidden');
        } else {
            // Success feedback?
        }
    } else {
        errorEl.textContent = "No valid transactions found in CSV. Check format.";
        errorEl.classList.remove('hidden');
    }
}

// --- Core Engine ---

/**
 * Calculates daily balances and monthly penalties
 * 
 * Rules:
 * 1. Excess = max(0, Contributions - Room - Withdrawals (careful))
 *    Actually, simpler logic: 
 *    Room Tracking:
 *      - Starts at R0
 *      - Contribution: Room -= Amount
 *      - Withdrawal: Room += Amount (BUT correction only available next year)
 *    
 *    Wait, CRA logic is specifically:
 *    Excess at time t = Contributions(t) - Withdrawals(t) - (StartingRoom + RoomCreatedThisYear)
 *    BUT Withdrawals do NOT create room in the current year.
 *    
 *    So, Effective Excess Logic:
 *    Let unused_room_available = Starting Room
 *    Running Excess = 0
 *    
 *    On Contribution: 
 *       unused_room_available -= amount
 *       if unused_room_available < 0, Excess = abs(unused_room_available)
 *       
 *    On Withdrawal:
 *       Effective Excess is reduced. 
 *       But unused_room_available does NOT increase for the purpose of absorbing future contributions in same year.
 *       
 *    This is tricky. Let's stick to the PRD Formula:
 *    E_t = max(0, C_t - R_0) 
 *    E_t_new = max(0, E_t_old - withdrawal_amount)
 *    
 *    Wait, the PRD formula "E_t = max(0, C_t - R_0)" assumes W_t is 0? 
 *    No, let's use the Ledger approach which is robust.
 *    
 *    Ledger State:
 *    - cumulative_contributions
 *    - cumulative_withdrawals_that_reduced_excess
 *    - diff = (cumulative_contributions - start_room)
 *    - excess = max(0, diff - cumulative_withdrawals) 
 *      ^ No, standard formula is: 
 *      Excess Amount = (Total Contributions) - (Cheque-less Withdrawals) - (TFSA Room)
 *      
 *      Actually, the "Withdrawal Rule":
 *      Withdrawals reduce the *taxable excess* immediately.
 *      They add to Contribution Room *next year*.
 *      
 *      Algorithm:
 *      1. Sort all tx by date.
 *      2. Iterate day by day (Jan 1 to Dec 31).
 *      3. On a day, process all transactions.
 *         - Contrib: Room Used += Amt
 *         - Withdraw: Room Used -= Amt (Wait! Only if currently in excess?)
 *         
 *      Let's look at CRA Example:
 *      Room $10k. Contrib $15k. Excess $5k.
 *      Withdraw $2k. Excess becomes $3k immediately.
 *      Contrib $2k. Excess becomes $5k.
 *      
 *      So, simply:
 *      Current Balance = (Start Room) - (Contributions) + (Withdrawals)
 *      If Balance < 0, then Excess = abs(Balance).
 *      
 *      WAIT. Correct Rule: 
 *      Withdrawals add to room NEXT year.
 *      In current year, they effectively "un-contribute" for the sake of penalty calculation.
 *      
 *      So yes: 
 *      Net_Position = Start_Room - Cumulative_Contributions + Cumulative_Withdrawals
 *      If Net_Position < 0: Excess = abs(Net_Position)
 *      Else: Excess = 0
 *      
 *      Is this always true?
 *      "Qualifying withdrawals" reduce the excess amount.
 *      Yes.
 *      
 *      So the logic is simply tracking the "TFSA Balance relative to Room".
 *      
 *      Let's execute:
 *      Daily Loop 1..365
 *      Apply txs.
 *      Record max excess for that month.
 */
const ANNUAL_LIMITS = {
    2023: 6500,
    2024: 7000,
    2025: 7000,
    2026: 7000 // Estimated
};

function calculatePenalty(year, startRoom, txs) {
    // 1. Setup Date Boundaries (UTC)
    const startDate = new Date(Date.UTC(year, 0, 1)); // Jan 1 00:00 UTC
    const endDate = new Date(Date.UTC(year, 11, 31)); // Dec 31 00:00 UTC

    // 2. Sort transactions
    const sortedTxs = [...txs].sort((a, b) => {
        // Compare string dates directly (YYYY-MM-DD)
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return 0;
    });
    let txIndex = 0;

    // 3. Initialization
    let excess = 0;
    let unusedRoom = 0;
    let totalWithdrawals = 0; // Track for next year
    let totalContributions = 0;

    // Handle Starting Condition
    if (startRoom < 0) {
        excess = Math.abs(startRoom);
        unusedRoom = 0;
    } else {
        excess = 0;
        unusedRoom = startRoom;
    }

    const monthlyMaxExcess = new Array(12).fill(0);
    const vizDataDates = [];
    const vizDataExcess = [];

    // 4. Daily Loop (Simulate entire year day-by-day)
    // We use a pointer 'currentDate' and increment it
    let iterDate = new Date(startDate);

    while (iterDate <= endDate) {
        // Format YYYY-MM-DD from UTC parts to avoid timezone shifts
        const y = iterDate.getUTCFullYear();
        const m = String(iterDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(iterDate.getUTCDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d}`;
        const monthIndex = iterDate.getUTCMonth();

        // Apply transactions for THIS day
        while (txIndex < sortedTxs.length) {
            const tx = sortedTxs[txIndex];
            if (tx.date === dateStr) {
                if (tx.type === 'CONTRIBUTION') {
                    totalContributions += tx.amount;
                    // Contrib: Consumes Room first, then creates Excess
                    if (unusedRoom >= tx.amount) {
                        unusedRoom -= tx.amount;
                    } else {
                        const spill = tx.amount - unusedRoom;
                        unusedRoom = 0;
                        excess += spill;
                    }
                } else if (tx.type === 'WITHDRAWAL') {
                    totalWithdrawals += tx.amount;
                    // Withdraw: Reduces Excess immediately.
                    // Important: Does NOT restore room in current year.
                    if (excess > 0) {
                        if (excess >= tx.amount) {
                            excess -= tx.amount;
                        } else {
                            excess = 0;
                            // Remaining withdrawal amount prevents future excess re-creation in theory?
                            // No, standard rule: Excess is calculated based on cumulative flow logic usually.
                            // But here, we just tracking simplistic "bucket" logic which is generally correct for basic cases.
                            // Technically if I withdraw 5000 (when 0 excess), I don't get 5000 room.
                            // If I then contribute 5000, I create 5000 excess? Yes.
                            // Our logic: excess=0. Withdraw 5000. excess=0. Contrib 5000. 
                            // unusedRoom=0. excess+=5000. 
                            // CORRECT.
                        }
                    }
                }
                txIndex++;
            } else {
                break; // Tx is in future
            }
        }

        // Track High-Water Mark for the Month
        if (excess > monthlyMaxExcess[monthIndex]) {
            monthlyMaxExcess[monthIndex] = excess;
        }

        // Save for Chart
        vizDataDates.push(dateStr);
        vizDataExcess.push(excess);

        // Next Day
        iterDate.setUTCDate(iterDate.getUTCDate() + 1);
    }

    // 5. Finalize Monthly Penalties
    let totalPenalty = 0;
    let affectedMonths = 0;

    const monthlyDetails = monthlyMaxExcess.map((max, idx) => {
        const penalty = max * 0.01; // 1% Rule
        totalPenalty += penalty;
        if (max > 0) affectedMonths++;

        return {
            month: MONTHS[idx],
            maxExcess: max,
            penalty: penalty,
            isAffected: max > 0
        };
    });

    // 6. Calculate Next Year's Room (Refined Logic)
    // Formula: Room_next = UnusedRoom_end_of_year + Withdrawals_current_year + NewAnnualLimit

    // Unused Room at end of year = Starting Room - Total Contributions
    // This value can be negative (representing excess that consumes next year's room)
    const unusedRoomEndOfYear = startRoom - totalContributions;

    // Withdrawals from current year are added back next year
    const withdrawalsToAddBack = totalWithdrawals;

    // New Annual Limit for next year
    const nextLimit = ANNUAL_LIMITS[parseInt(year) + 1] || 7000;

    // Final Calculation
    const nextYearRoom = unusedRoomEndOfYear + withdrawalsToAddBack + nextLimit;

    // Current Year Remaining Room
    // Remaining = max(0, StartRoom - TotalContributions)
    // Withdrawals do NOT increase room for the CURRENT year.
    const currentYearRemaining = Math.max(0, startRoom - totalContributions);

    return {
        totalPenalty: totalPenalty,
        peakExcess: Math.max(...monthlyMaxExcess), // This is the yearly peak
        currentExcess: excess, // The valid ending excess
        remainingRoom: currentYearRemaining,
        nextYearLimit: nextYearRoom,
        // Additional Details for UI
        totalContributions: totalContributions,
        totalWithdrawals: totalWithdrawals,
        unusedRoomEndOfYear: unusedRoomEndOfYear,
        nextAnnualLimit: nextLimit,

        affectedMonths: affectedMonths,
        monthlyDetails: monthlyDetails,
        vizData: { labels: vizDataDates, data: vizDataExcess }
    };
}

// --- UI Actions ---

function addTransaction() {
    const errorEl = inputs.addTxError;
    errorEl.classList.add('hidden');

    const date = inputs.txDate.value;
    const amount = parseFloat(inputs.txAmount.value);
    const type = inputs.txType.value;
    const institution = inputs.txInstitution.value;
    const year = inputs.year.value;

    // Validation
    if (!institution) {
        showError('Please select a financial institution.');
        return;
    }
    if (!date || !amount || isNaN(amount)) {
        showError('Please enter a valid date and amount.');
        return;
    }
    if (amount <= 0) {
        showError('Amount must be positive.');
        return;
    }
    if (date.slice(0, 4) !== year) {
        showError(`Date must be in ${year}.`);
        return;
    }

    // Add
    const tx = {
        id: Date.now(),
        date,
        amount,
        type,
        institution
    };
    transactions.push(tx);

    // Reset Form (keep date for convenience?)
    inputs.txAmount.value = '';
    inputs.txType.value = 'CONTRIBUTION'; // Reset to default

    renderTxList();
    recalculateAll();
}

function removeTransaction(id) {
    transactions = transactions.filter(t => t.id !== id);
    renderTxList();
    recalculateAll();
}

function showError(msg) {
    inputs.addTxError.textContent = msg;
    inputs.addTxError.classList.remove('hidden');
}

function renderTxList() {
    inputs.txList.innerHTML = '';
    inputs.txCount.textContent = `${transactions.length} items`;

    // Sort for display (reverse chrono)
    const sorted = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (sorted.length === 0) {
        inputs.txList.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm italic">No transactions added yet.</div>';
        return;
    }

    sorted.forEach(tx => {
        const el = document.createElement('div');
        el.className = 'p-3 flex justify-between items-center group hover:bg-slate-50 transition-colors';
        const isContrib = tx.type === 'CONTRIBUTION';

        el.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full flex items-center justify-center ${isContrib ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}">
                    ${isContrib ? '+' : '-'}
                </div>
                <div>
                    <div class="text-sm font-medium text-slate-700">${isContrib ? 'Contribution' : 'Withdrawal'} <span class="text-slate-400 font-normal">• ${tx.institution}</span></div>
                    <div class="text-xs text-slate-500">${tx.date}</div>
                </div>
            </div>
            <div class="flex items-center gap-4">
                <span class="font-mono text-sm ${isContrib ? 'text-slate-900' : 'text-slate-500'}">
                    $${tx.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
                <button onclick="removeTransaction(${tx.id})" class="text-slate-300 hover:text-red-500 transition-colors p-1" title="Remove">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
        `;
        inputs.txList.appendChild(el);
    });
}

function recalculateAll() {
    const year = inputs.year.value;
    const startRoom = parseFloat(inputs.startRoom.value) || 0;

    const result = calculatePenalty(year, startRoom, transactions);

    // Update Summary
    outputs.totalPenalty.textContent = formatCurrency(result.totalPenalty);
    outputs.peakExcess.textContent = formatCurrency(result.peakExcess);
    outputs.monthsAffected.textContent = result.affectedMonths;
    if (outputs.remainingRoom) {
        outputs.remainingRoom.textContent = formatCurrency(result.remainingRoom);
        // Visual cue: if 0, maybe gray out?
        if (result.remainingRoom > 0) {
            outputs.remainingRoom.classList.remove('text-slate-400');
            outputs.remainingRoom.classList.add('text-indigo-600');
        } else {
            outputs.remainingRoom.classList.remove('text-indigo-600');
            outputs.remainingRoom.classList.add('text-slate-400');
        }
    }
    if (outputs.nextYearRoom) outputs.nextYearRoom.textContent = formatCurrency(result.nextYearLimit);
    if (outputs.nextYearRoom) outputs.nextYearRoom.textContent = formatCurrency(result.nextYearLimit);
    if (outputs.totalContributions) outputs.totalContributions.textContent = formatCurrency(result.totalContributions);

    // Update Dynamic Labels
    const startRoomLabel = document.getElementById('startRoomLabel');
    const remainingRoomLabel = document.getElementById('remainingRoomLabel');
    const nextYearRoomLabel = document.getElementById('nextYearRoomLabel');

    if (startRoomLabel) startRoomLabel.textContent = `On Jan 1st of ${year}`;
    if (remainingRoomLabel) remainingRoomLabel.textContent = `Available to contribute in ${year}`;
    if (nextYearRoomLabel) nextYearRoomLabel.textContent = `Est. Limit on Jan 1, ${parseInt(year) + 1}`;
    if (outputs.totalWithdrawals) outputs.totalWithdrawals.textContent = formatCurrency(result.totalWithdrawals);

    // Update Table Footer
    outputs.tableTotalPenalty.textContent = formatCurrency(result.totalPenalty);
    outputs.tableMaxExcess.textContent = formatCurrency(result.peakExcess);

    // Update Table
    renderMonthlyTable(result.monthlyDetails);

    // Update Chart
    renderChart(result.monthlyDetails);
}

function renderMonthlyTable(monthlyData) {
    outputs.monthlyTableBody.innerHTML = '';

    monthlyData.forEach(m => {
        const tr = document.createElement('tr');
        tr.className = m.isAffected ? 'bg-red-50/50' : '';
        tr.innerHTML = `
            <td class="px-6 py-3 font-medium ${m.isAffected ? 'text-red-700' : ''}">${m.month}</td>
            <td class="px-6 py-3 text-right font-mono text-slate-600 transition-colors ${m.isAffected ? 'font-semibold text-red-700' : ''}">
                ${m.maxExcess > 0 ? formatCurrency(m.maxExcess) : '-'}
            </td>
            <td class="px-6 py-3 text-right font-mono text-slate-600 transition-colors ${m.isAffected ? 'font-semibold text-red-700' : ''}">
                ${m.penalty > 0 ? formatCurrency(m.penalty) : '-'}
            </td>
            <td class="px-6 py-3 text-center">
                ${m.isAffected ? '<span class="inline-block w-2 h-2 rounded-full bg-red-500"></span>' : '<span class="inline-block w-2 h-2 rounded-full bg-slate-200"></span>'}
            </td>
        `;
        outputs.monthlyTableBody.appendChild(tr);
    });
}

function renderChart(monthlyData) {
    const ctx = outputs.chartCanvas.getContext('2d');

    if (chartInstance) {
        chartInstance.destroy();
    }

    // Extract Data for Chart
    const labels = monthlyData.map(m => m.month);
    const data = monthlyData.map(m => m.maxExcess);
    // Dynamic color: Red if penalty exists
    const backgroundColors = monthlyData.map(m => m.maxExcess > 0 ? 'rgba(211, 47, 47, 0.7)' : 'rgba(148, 163, 184, 0.2)');
    const borderColors = monthlyData.map(m => m.maxExcess > 0 ? '#D32F2F' : '#cbd5e1');

    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Taxable Excess (Monthly Peak)',
                data: data,
                backgroundColor: backgroundColors,
                borderColor: borderColors,
                borderWidth: 1,
                borderRadius: 4,
                barPercentage: 0.6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `Max Excess: ${formatCurrency(ctx.raw)}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    grid: { borderDash: [2, 4] },
                    ticks: {
                        callback: function (value) {
                            return '$' + value;
                        }
                    }
                }
            }
        }
    });
}

function formatCurrency(num) {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(num);
}
