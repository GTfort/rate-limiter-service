/**
 * Load testing script to compare algorithm performance
 * Measures:
 * - Requests per second
 * - Memory usage
 * - Redis operations count
 * - Accuracy under load
 */
import autocannon from "autocannon";

const runBenchmark = async (algorithm: string) => {
  const result = await autocannon({
    url: "http://localhost:3000/api/test",
    connections: 100,
    duration: 30,
    headers: {
      "X-Algorithm": algorithm,
    },
  });

  console.log(`\n=== ${algorithm} Algorithm ===`);
  console.log(`Requests/sec: ${result.requests.average}`);
  console.log(`Latency (avg): ${result.latency.average}ms`);
  console.log(`Errors: ${result.errors}`);
  console.log(`Throughput: ${result.throughput.average} bytes/sec`);
};
