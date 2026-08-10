/**
 * Hotel Career - THE LEDGER. Every day, every line, kept as data.
 *
 * The operator's brief: "for P&L everything must be saved as json for now (later
 * this will be DB if the game goes live) and to be able to get every report, how
 * many guests, when they were here, what was the profit, what was the revenue,
 * spending and etc."
 *
 * So this is not a summary. It is the BOOKS - one row per trading day with every
 * line item separated, plus the guest register underneath it, in a shape that
 * moves to a real database without being rewritten:
 *
 *   - flat rows, no nesting beyond one level
 *   - a stable `day` integer as the natural key
 *   - every money field an integer, never a formatted string
 *   - nothing derived that cannot be recomputed from what is stored
 *
 * WHY THAT LAST RULE MATTERS. A ledger that stores `profit` but not the lines it
 * came from can never answer a question nobody thought of yet. Storing revenue
 * AND every cost separately means "what did linen cost me in week three" is a
 * query rather than a code change.
 *
 * Pure, and no wall clock: `at` is passed in.
 */

/** Bumped when the row shape changes in a way a reader must notice. */
export const LEDGER_VERSION = 1;

/**
 * How many days of full detail to keep. A phone should not carry a year of
 * per-guest rows; the daily P&L rows are small and are kept much longer.
 */
export const KEEP_GUEST_ROWS = 60;
export const KEEP_DAY_ROWS = 400;

/**
 * One trading day, fully itemised.
 *
 * Built from a `score()` result plus the property context the result does not
 * know about. Everything is an integer except `rating` and `occupancy`.
 */
export function dayRow(result, context = {}) {
  const fnb = result.facilityBreakdown ?? {};
  return {
    day: context.day ?? null,
    at: context.at ?? null,
    /** worked | unsupervised | closed - how the day was earned. */
    source: context.source ?? "worked",
    rank: context.rank ?? null,
    stars: result.stars ?? null,

    /* ------------------------------------------------------------ revenue */
    /**
     * ROOMS ONLY - tips and desk upsells are BACKED OUT.
     *
     * `takings` is the till: the engine adds tips and upgrade sales straight
     * into it (`shift.money += tip`). Reporting takings AND tips AND upsells as
     * separate revenue lines counted the same money up to three times, which is
     * the kind of error a ledger exists to prevent. Split so the four lines sum
     * to exactly what came in.
     */
    roomsRevenue: Math.round((result.takings ?? 0)
      - (result.tips ?? 0) - (result.upsellRevenue ?? 0)),
    tips: Math.round(result.tips ?? 0),
    upsellRevenue: Math.round(result.upsellRevenue ?? 0),
    fnbRevenue: Math.round(result.facilityRevenue ?? 0),

    /* -------------------------------------------------------------- costs */
    wages: Math.round(result.wages ?? 0),
    fnbBrigade: Math.round(result.facilityLabour ?? 0),
    fnbCogs: Math.round(result.facilityCogs ?? 0),
    fnbUpkeep: Math.round(result.facilityUpkeep ?? 0),
    supplies: Math.round(result.supplies ?? 0),
    /** Linen, amenities, desk stock, parts - kept separate, not lumped. */
    supplyByKind: { ...(result.supplyByKind ?? {}) },

    /* ------------------------------------------------------------- result */
    profit: Math.round(result.profit ?? 0),

    /* ----------------------------------------------------------- the house */
    rooms: context.rooms ?? result.roomCount ?? 0,
    roomsSold: result.checkedIn ?? 0,
    nightsSold: result.nightsSold ?? 0,
    guestsInHouse: result.coversBase ?? result.guestsInHouse ?? 0,
    occupancy: context.occupancy ?? null,
    roomRate: result.roomRate ?? 0,
    fairRate: result.fairRate ?? 0,

    /* ------------------------------------------------------------- service */
    rating: result.rating ?? null,
    satisfaction: result.satisfaction ?? null,
    walkedOut: result.walkedOut ?? 0,
    relocated: result.overbooked ?? 0,
    upsellsSold: result.upsells ?? 0,
    upgradesGiven: result.upgradesGiven ?? 0,
    bookingsTaken: result.bookingsTaken ?? 0,
    bookingsDeclined: result.bookingsDeclined ?? 0,
    coversTurnedAway: result.coversTurnedAway ?? 0,

    /* ----------------------------------------------------- F&B, per outlet */
    outlets: Object.entries(fnb).map(([outlet, line]) => ({
      outlet,
      open: line.open !== false,
      covers: line.covers ?? 0,
      cheque: line.cheque ?? 0,
      revenue: line.revenue ?? 0,
      foodCost: line.foodCost ?? 0,
      drinkCost: line.drinkCost ?? 0,
      waste: line.waste ?? 0,
      labour: line.labour ?? 0,
      upkeep: line.upkeep ?? 0,
      net: line.net ?? 0,
    })),
  };
}

/**
 * The guest register: who was here, when, in which room, and what they paid.
 *
 * Written when a booking departs, because that is the point at which its whole
 * story is known. Answers "how many guests, when they were here" directly.
 */
export function guestRow(booking, context = {}) {
  return {
    id: booking.id,
    arrivalDay: booking.arrivalDay,
    departureDay: booking.departureDay,
    nights: booking.nights,
    guests: booking.guests,
    roomId: booking.roomId,
    roomNumber: context.roomNumber ?? null,
    roomType: context.roomType ?? booking.requestedType ?? null,
    rate: Math.round(booking.rate ?? 0),
    upsell: Math.round(booking.upsell ?? 0),
    compensation: Math.round(booking.compensation ?? 0),
    revenue: Math.round(booking.totalRevenue ?? 0),
    source: booking.source ?? null,
  };
}

export function createLedger() {
  return { version: LEDGER_VERSION, days: [], guests: [] };
}

/** Append a day. Idempotent on `day` - a day is never booked twice. */
export function recordDay(ledger, row) {
  const next = normalise(ledger);
  if (row.day !== null && next.days.some((d) => d.day === row.day)) return next;
  next.days = [...next.days, row].slice(-KEEP_DAY_ROWS);
  return next;
}

export function recordGuests(ledger, rows) {
  if (rows.length === 0) return normalise(ledger);
  const next = normalise(ledger);
  const known = new Set(next.guests.map((g) => g.id));
  const fresh = rows.filter((g) => !known.has(g.id));
  next.guests = [...next.guests, ...fresh].slice(-KEEP_GUEST_ROWS * 6);
  return next;
}

function normalise(ledger) {
  const base = ledger ?? createLedger();
  return {
    version: LEDGER_VERSION,
    days: Array.isArray(base.days) ? [...base.days] : [],
    guests: Array.isArray(base.guests) ? [...base.guests] : [],
  };
}

/* ------------------------------------------------------------- reporting -- */

/**
 * Totals over a span of days. `from`/`to` are day numbers, both inclusive;
 * omitting them reports everything.
 *
 * Every figure is summed from stored lines rather than from a stored total,
 * which is what lets a span be re-cut any way somebody later wants it.
 */
export function report(ledger, { from = -Infinity, to = Infinity } = {}) {
  const days = normalise(ledger).days.filter((d) => d.day >= from && d.day <= to);
  const sum = (pick) => days.reduce((t, d) => t + (pick(d) || 0), 0);

  const revenue = sum((d) => d.roomsRevenue) + sum((d) => d.fnbRevenue)
    + sum((d) => d.tips) + sum((d) => d.upsellRevenue);
  const costs = sum((d) => d.wages) + sum((d) => d.fnbBrigade) + sum((d) => d.fnbCogs)
    + sum((d) => d.fnbUpkeep) + sum((d) => d.supplies);

  const rated = days.filter((d) => d.rating !== null);
  const outlets = {};
  for (const day of days) {
    for (const line of day.outlets ?? []) {
      const o = outlets[line.outlet] ?? (outlets[line.outlet] = {
        covers: 0, revenue: 0, cost: 0, net: 0,
      });
      o.covers += line.covers;
      o.revenue += line.revenue;
      o.cost += line.foodCost + line.drinkCost + line.labour + line.upkeep;
      o.net += line.net;
    }
  }

  const supplies = {};
  for (const day of days) {
    for (const [kind, spent] of Object.entries(day.supplyByKind ?? {})) {
      supplies[kind] = (supplies[kind] ?? 0) + spent;
    }
  }

  return {
    days: days.length,
    from: days.length ? days[0].day : null,
    to: days.length ? days[days.length - 1].day : null,

    revenue,
    roomsRevenue: sum((d) => d.roomsRevenue),
    fnbRevenue: sum((d) => d.fnbRevenue),
    tips: sum((d) => d.tips),
    upsellRevenue: sum((d) => d.upsellRevenue),

    costs,
    wages: sum((d) => d.wages),
    fnbBrigade: sum((d) => d.fnbBrigade),
    fnbCogs: sum((d) => d.fnbCogs),
    fnbUpkeep: sum((d) => d.fnbUpkeep),
    supplies: sum((d) => d.supplies),
    supplyByKind: supplies,

    profit: sum((d) => d.profit),
    /** Profit as a share of revenue - the number an owner actually reads. */
    margin: revenue > 0 ? Math.round((sum((d) => d.profit) / revenue) * 1000) / 10 : null,

    nightsSold: sum((d) => d.nightsSold),
    roomsSold: sum((d) => d.roomsSold),
    walkedOut: sum((d) => d.walkedOut),
    relocated: sum((d) => d.relocated),
    upsellsSold: sum((d) => d.upsellsSold),
    /** Average daily rate - takings per night actually sold. */
    adr: sum((d) => d.nightsSold) > 0
      ? Math.round(sum((d) => d.roomsRevenue) / sum((d) => d.nightsSold)) : null,
    bestDay: days.reduce((best, d) => (!best || d.profit > best.profit ? d : best), null),
    worstDay: days.reduce((w, d) => (!w || d.profit < w.profit ? d : w), null),
    averageRating: rated.length
      ? Math.round((rated.reduce((t, d) => t + d.rating, 0) / rated.length) * 100) / 100
      : null,
    outlets,
  };
}

/** Guests who were in the house on a given day. "When were they here." */
export function guestsOn(ledger, day) {
  return normalise(ledger).guests
    .filter((g) => g.arrivalDay <= day && g.departureDay > day);
}

/** The whole books, as JSON. This is the thing that becomes a DB table later. */
export function exportLedger(ledger, meta = {}) {
  const l = normalise(ledger);
  return JSON.stringify({
    version: LEDGER_VERSION,
    exportedAt: meta.at ?? null,
    property: meta.property ?? null,
    summary: report(l),
    days: l.days,
    guests: l.guests,
  }, null, 2);
}
