import test from "node:test";
import assert from "node:assert/strict";
import { fetchProviderText } from "../src/provider-request.js";
import { QuarkShareClient, QuarkShareError } from "../src/quark-share.js";
import { AliyunShareClient, AliyunShareError } from "../src/aliyun-share.js";

const config = { providerName: "夸克网盘", ErrorClass: QuarkShareError };

function networkFailure(code) {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(code), { code }),
  });
}

function abortableOperation(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 10000);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("successful provider JSON requests preserve headers, method and body", async () => {
  const client = new QuarkShareClient({
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        pwd_id: "example",
        passcode: "1234",
      });
      assert.equal(options.headers.origin, "https://pan.quark.cn");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(
        JSON.stringify({ status: 200, data: { stoken: "test-token" } }),
      );
    },
  });
  assert.equal(await client.getStoken("example", "1234"), "test-token");
});

test("Quark connection timeouts become readable provider errors", async () => {
  const client = new QuarkShareClient({
    fetchImpl: async () => {
      throw networkFailure("UND_ERR_CONNECT_TIMEOUT");
    },
  });
  await assert.rejects(client.getStoken("example"), (error) => {
    assert.ok(error instanceof QuarkShareError);
    assert.equal(error.details.code, "provider_timeout");
    assert.equal(error.details.retryable, true);
    assert.match(error.message, /连接夸克网盘超时/);
    return true;
  });
});

test("DNS failures become unreachable-provider errors without claiming the share is invalid", async () => {
  const client = new QuarkShareClient({
    fetchImpl: async () => {
      throw networkFailure("ENOTFOUND");
    },
  });
  await assert.rejects(client.getStoken("example"), (error) => {
    assert.equal(error.details.code, "provider_unreachable");
    assert.match(error.message, /暂时无法连接夸克网盘/);
    return true;
  });
});

test("the deadline also bounds a stalled response body", async () => {
  await assert.rejects(
    fetchProviderText(
      async (_url, options) => ({
        text: () => abortableOperation(options.signal),
      }),
      "https://example.test",
      {},
      { ...config, timeoutMs: 20 },
    ),
    (error) => {
      assert.ok(error instanceof QuarkShareError);
      assert.equal(error.details.code, "provider_timeout");
      return true;
    },
  );
});

test("caller cancellation is preserved and never marked retryable", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchProviderText(
      (_url, options) => abortableOperation(options.signal),
      "https://example.test",
      { signal: controller.signal },
      config,
    ),
    (error) => {
      assert.equal(error.details.code, "provider_request_cancelled");
      assert.equal(error.details.retryable, false);
      return true;
    },
  );
});

test("non-JSON provider responses remain domain errors", async () => {
  const client = new QuarkShareClient({
    fetchImpl: async () =>
      new Response("<html>Unavailable</html>", { status: 502 }),
  });
  await assert.rejects(client.getStoken("example"), (error) => {
    assert.ok(error instanceof QuarkShareError);
    assert.match(error.message, /not JSON/);
    assert.equal(error.details.status, 502);
    return true;
  });
});

test("Aliyun still retries transient network failures", async () => {
  let attempts = 0;
  const client = new AliyunShareClient({
    requestDelayMs: 0,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) throw networkFailure("ECONNRESET");
      return new Response(JSON.stringify({ share_token: "test-token" }));
    },
  });
  assert.equal(await client.getShareToken("example"), "test-token");
  assert.equal(attempts, 2);
});

test("Aliyun provider rejections are not incorrectly classified as network failures", async () => {
  let attempts = 0;
  const client = new AliyunShareClient({
    requestDelayMs: 0,
    fetchImpl: async () => {
      attempts++;
      return new Response(
        JSON.stringify({ code: "ShareLink.Cancelled", message: "分享已取消" }),
        { status: 404 },
      );
    },
  });
  await assert.rejects(client.getShareToken("example"), (error) => {
    assert.ok(error instanceof AliyunShareError);
    assert.equal(error.message, "分享已取消");
    return true;
  });
  assert.equal(attempts, 1);
});
