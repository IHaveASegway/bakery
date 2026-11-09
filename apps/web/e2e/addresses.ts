// The synthetic client addresses the e2e suite gives the API as CF-Connecting-IP, one per call.
// The API limits sandbox creation to one a minute per address, so two tests that shared one could
// refuse each other. Until 2026-11-09 a hash of the test's title picked one of 254 TEST-NET-1
// addresses, and two titles could land on the same one (the campaign spec's first title did, #85).
// Now each address is the worker's index and a counter, inside the IPv6 documentation prefix
// 2001:db8::/32 (RFC 3849): Playwright never reuses a worker index within a run, and a counter
// never repeats, so no two tests of one run share an address. test/e2e-addresses.test.ts checks it.

/** Hands out addresses for one worker; each throws rather than repeat an address it gave. */
export function clientAddresses() {
  const given = new Set<string>();
  let count = 0;
  return (workerIndex: number): string => {
    count += 1;
    const address = `2001:db8:e2e:${workerIndex.toString(16)}::${count.toString(16)}`;
    if (given.has(address)) throw new Error(`client address ${address} handed out twice`);
    given.add(address);
    return address;
  };
}

/** The suite's one allocator: a worker is one process, so this is the worker's. */
export const nextClientIp = clientAddresses();
