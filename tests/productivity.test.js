/**
 * Test suite for productivity score calculation
 * Verifies that scores stay between 0-100 across all scenarios
 */

// Mock the calculateProductivity function for testing
function calculateProductivity(commits, workMinutes) {
  commits = commits || 0;
  workMinutes = workMinutes || 0;

  if (commits === 0 && workMinutes === 0) {
    return null;
  }

  const commitScore = Math.min((commits / 5) * 50, 50);
  const workScore = Math.min((workMinutes / 240) * 50, 50);
  const totalScore = Math.round(commitScore + workScore);
  return Math.max(0, Math.min(100, totalScore));
}

// Test cases
const tests = [
  {
    name: "Both metrics missing",
    commits: 0,
    workMinutes: 0,
    expected: null,
  },
  {
    name: "Ideal day (5 commits, 240 min work)",
    commits: 5,
    workMinutes: 240,
    expected: 100,
  },
  {
    name: "No commits, 4h work",
    commits: 0,
    workMinutes: 240,
    expected: 50,
  },
  {
    name: "5 commits, no work time",
    commits: 5,
    workMinutes: 0,
    expected: 50,
  },
  {
    name: "Partial: 2 commits, 1h work",
    commits: 2,
    workMinutes: 60,
    expected: 33, // ~32.5 rounded
  },
  {
    name: "Exceeding targets (10 commits, 8h work)",
    commits: 10,
    workMinutes: 480,
    expected: 100, // Should clamp at 100
  },
  {
    name: "Just started (1 commit, 30 min work)",
    commits: 1,
    workMinutes: 30,
    expected: 13, // (1/5)*50 + (30/240)*50 = 10 + 6.25
  },
  {
    name: "High productivity (7 commits, 300 min)",
    commits: 7,
    workMinutes: 300,
    expected: 98, // (7/5)*50 = 70, capped at 50; (300/240)*50 = 62.5, capped at 50
  },
  {
    name: "Edge: negative commits treated as 0",
    commits: -5,
    workMinutes: 120,
    expected: 25,
  },
  {
    name: "7-day average (2.1 avg commits, 200 min work)",
    commits: 2.1,
    workMinutes: 200,
    expected: 63, // (2.1/5)*50 + (200/240)*50 = 21 + 41.67
  },
  {
    name: "30-day average (1.5 avg commits, 150 min work)",
    commits: 1.5,
    workMinutes: 150,
    expected: 44, // (1.5/5)*50 + (150/240)*50 = 15 + 31.25
  },
];

// Run tests
console.log("=== Productivity Score Test Suite ===\n");
let passed = 0;
let failed = 0;

tests.forEach((test) => {
  const result = calculateProductivity(test.commits, test.workMinutes);
  const success = result === test.expected;

  if (success) {
    passed++;
    console.log(`✓ ${test.name}`);
    console.log(`  Input: commits=${test.commits}, workMinutes=${test.workMinutes}`);
    console.log(`  Expected: ${test.expected}, Got: ${result}\n`);
  } else {
    failed++;
    console.log(`✗ FAILED: ${test.name}`);
    console.log(`  Input: commits=${test.commits}, workMinutes=${test.workMinutes}`);
    console.log(`  Expected: ${test.expected}, Got: ${result}`);
    console.log(`  Difference: ${Math.abs(result - test.expected)}\n`);
  }
});

// Verify all results are in valid range [0, 100]
console.log("=== Bounds Verification ===\n");
const allTests = tests.map((t) => calculateProductivity(t.commits, t.workMinutes));
const outOfBounds = allTests.filter(
  (score) => score !== null && (score < 0 || score > 100)
);

if (outOfBounds.length === 0) {
  console.log("✓ All non-null scores are within [0, 100]\n");
} else {
  console.log(`✗ Found ${outOfBounds.length} scores out of bounds:`);
  console.log(outOfBounds);
}

// Summary
console.log("=== Summary ===");
console.log(`Passed: ${passed}/${tests.length}`);
console.log(`Failed: ${failed}/${tests.length}`);
console.log(`Out of bounds: ${outOfBounds.length}`);
console.log(`\nFormula: commitScore (0-50) + workScore (0-50) = total (0-100)`);
console.log(`- commitScore = min((commits / 5) * 50, 50)`);
console.log(`- workScore = min((workMinutes / 240) * 50, 50)`);
