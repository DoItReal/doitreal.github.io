/**
 * Hotel Career - WHAT YOU HAVE TO DO TO OPEN A DEPARTMENT.
 *
 * Operator, after playtest:
 *
 *   "i cant progress to the next staff goals normally i have to use dev tools to
 *    skip 1h ... There must be some goals like 10 check-ins and 300$ profit to
 *    unlock receptionist, and is up to the player what he wants to do. With the
 *    other roles too."
 *
 * WHAT THIS REPLACES. A department used to open on two invisible conditions: a
 * rank whose experience bar moved only at midnight, and a `learnedRoles` list
 * the player never saw. Neither was a goal - they were states the game arrived
 * at on its own, which is why the only way to make progress happen was the dev
 * panel. There was nothing to aim at.
 *
 * THE RULE NOW: every department is opened by work the player can see themselves
 * doing, counted as they do it. Ten check-ins is a thing you can decide to go
 * and do. "260 experience" is not.
 *
 * TWO CONDITIONS EACH, DELIBERATELY. A count of the JOB, so the department is
 * earned by doing the work it exists to replace - and a MONEY bar, so a hotel
 * that cannot pay wages cannot hire. Either alone is gameable: work without
 * money hires staff you cannot afford, money without work lets a lucky rate
 * buy a department the player has never seen.
 *
 * UNVERIFIED - all of them except reception. Method: reception's 10 check-ins
 * and $300 are the operator's own numbers. The rest step up from there in
 * proportion to how much later in the arc the department arrives, and are set so
 * each is reachable in roughly one to two days of working that department.
 * These are exactly the sort of figure a playtest corrects, and they are all in
 * this one table so correcting them is a one-file job.
 */

/**
 * @typedef {object} DepartmentGoal
 * @property {string} counter The career counter this department is earned by.
 * @property {number} need    How many.
 * @property {number} profit  Lifetime profit required alongside it.
 * @property {string} doing   What the player is actually doing, in their words.
 */

/** @type {Record<string, DepartmentGoal>} */
export const DEPARTMENT_GOALS = {
  // The operator's own figures.
  reception: { counter: "checkIns", need: 10, profit: 300, doing: "check guests in" },
  bellboy: { counter: "escorts", need: 12, profit: 900, doing: "walk guests to their room" },
  housekeeping: { counter: "cleans", need: 15, profit: 2000, doing: "turn rooms" },
  maintenance: { counter: "repairs", need: 8, profit: 3500, doing: "fix what breaks" },
  reservations: { counter: "calls", need: 12, profit: 5000, doing: "take bookings on the phone" },
};

/** A fresh career: every counter at zero. */
export function emptyCareer() {
  return {
    checkIns: 0, checkOuts: 0, escorts: 0, cleans: 0,
    repairs: 0, calls: 0, requests: 0, preps: 0, profit: 0,
  };
}

/**
 * How far along this department is, and what is still missing.
 *
 * Returns gaps in the terms the player acts in - "6 more check-ins", not a
 * ratio - because this text goes straight onto the floor and onto the staff
 * screen, and it is the only instruction the game gives about what to do next.
 */
export function unlockProgress(career = {}, role) {
  const goal = DEPARTMENT_GOALS[role];
  if (!goal) return { known: false, met: true, gaps: [], goal: null };

  const done = Math.max(0, career[goal.counter] ?? 0);
  const profit = Math.max(0, career.profit ?? 0);
  const gaps = [];

  if (done < goal.need) {
    gaps.push({
      kind: "work",
      text: `${goal.need - done} more to ${goal.doing}`,
      have: done,
      need: goal.need,
    });
  }
  if (profit < goal.profit) {
    gaps.push({
      kind: "profit",
      text: `$${goal.profit - profit} more profit`,
      have: profit,
      need: goal.profit,
    });
  }
  return { known: true, met: gaps.length === 0, gaps, goal };
}

export function isUnlocked(career, role) {
  return unlockProgress(career, role).met;
}

/**
 * The department the player is closest to opening, and has not opened yet.
 *
 * What the floor's goal line shows. Closest by the WORK counter rather than by
 * money, because the work is the part the player controls minute to minute -
 * money follows from it.
 */
export function nextDepartment(career = {}, staffedRoles = [], options = {}) {
  const staffed = new Set(staffedRoles);
  /**
   * A GOAL YOU HAVE MET BUT NOT ACTED ON MUST NOT BLOCK THE NEXT ONE.
   *
   * Operator: "When i fulfilled the first goal and it let me hire reception the
   * goal doesnt change auto, if i do not want to hire reception is up to me. The
   * next goal must not be stopped."
   *
   * Hiring is the player's choice - the whole point of the design is that they
   * CAN work every job themselves and pay nobody. So a met goal is an offer
   * standing open, not a gate: `skipMet` walks past anything already earned and
   * shows the next thing there is to go and do. The offer does not expire - the
   * staff screen still has the position open whenever they want it.
   */
  const skipMet = options.skipMet === true;
  /**
   * ONLY DEPARTMENTS THE PLAYER'S RANK COULD ACTUALLY EMPLOY.
   *
   * THE BUG THIS FIXES, found while auditing the goals after the operator's
   * playtest: this ranked departments purely by how far along their WORK
   * counter was, and ignored rank entirely. Measured with a probe - a rank-1
   * player who has answered six phones is told "Open reservations", a
   * department no rank below 4 may employ. The goal line is the game's only
   * instruction about what to do next, so that is an instruction leading
   * nowhere, and day 5 hands the player phone calls BY DESIGN, so the arc
   * itself triggers it.
   *
   * This is the same defect `Progression.unlocksAt` was written to fix on the
   * staff screen - "a rank-1 player was told a Head receptionist could employ a
   * reservations manager" - reappearing in a second place. Which is the
   * argument for `employable` being passed in rather than recomputed: the
   * caller already knows the rank, and this module stays dependency-free.
   *
   * Omitted means no filter, so every existing caller and test behaves as it did.
   */
  const employable = options.employable ? new Set(options.employable) : null;
  let best = null;
  for (const role of Object.keys(DEPARTMENT_GOALS)) {
    if (staffed.has(role)) continue;
    if (employable && !employable.has(role)) continue;
    const progress = unlockProgress(career, role);
    if (skipMet && progress.met) continue;
    const goal = progress.goal;
    const share = Math.min(1, (career[goal.counter] ?? 0) / goal.need);
    if (!best || share > best.share) best = { role, share, ...progress };
  }
  return best;
}

/**
 * How far along this department is, as ONE number, bound by whichever half is
 * furthest behind.
 *
 * THE BUG THIS FIXES. The floor's goal bar was drawn from the WORK gap alone,
 * and a gap that is MET is simply absent from the list - so once the player had
 * done the ten check-ins, the bar jumped to 100% and stayed there while the
 * money half was still short. The operator saw exactly that: a full bar, and
 * "$16 more profit" underneath it, with nothing moving. A bar that reads done
 * on an unmet goal is worse than no bar.
 *
 * Both halves have to be met, so the honest single number is the minimum.
 */
export function unlockShare(career = {}, role) {
  const goal = DEPARTMENT_GOALS[role];
  if (!goal) return 1;
  const work = Math.min(1, Math.max(0, career[goal.counter] ?? 0) / Math.max(1, goal.need));
  const money = Math.min(1, Math.max(0, career.profit ?? 0) / Math.max(1, goal.profit));
  return Math.min(work, money);
}
