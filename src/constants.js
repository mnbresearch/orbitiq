// ============================================================
// OrbitIQ — shared physical constants.
//
// These lived in four different files with two different values for the
// Earth's radius (6371 and 6378.137). That is not a rounding quibble: the
// 7.14 km difference pushed roughly a third of objects into the adjacent
// 25 km congestion shell, so the shell-density term of the Fleet Risk Index
// was reading a neighbouring shell for those objects, and the altitude
// printed on a conjunction event disagreed with the altitude printed on its
// own assessment. One definition, imported everywhere.
// ============================================================

/**
 * Equatorial radius, WGS-84. Altitudes across OrbitIQ are heights above this
 * radius, which is the convention SGP4 itself uses (6378.135 in the original
 * model — the 2 m difference is far below our position uncertainty).
 */
export const EARTH_R_KM = 6378.137;

/** Earth's gravitational parameter, km^3/s^2. */
export const MU_KM3_S2 = 398600.4418;

/**
 * The fastest credible closing speed between two objects in Earth orbit.
 *
 * Two objects in opposing near-circular low orbits close at about
 * 2 x 7.7 = 15.4 km/s. A head-on encounter between a LEO object and one on a
 * highly eccentric transfer can exceed that briefly near perigee, so 16 km/s
 * is used as the bound. Screening completeness is guaranteed only for pairs
 * closing at or below this speed, and that guarantee is reported in the
 * response rather than assumed.
 */
export const V_REL_MAX_KMS = 16;
