const webpush = require("web-push");

const OWNER = "kabu-rashinban";
const DASHBOARD_REPO = "kabu-rashinban-dashboard";
const BRANCH = "main";
const WATCHLIST_PATH = "watchlist.json";
const STATE_PATH = ".kabu-rashinban-alert-state.json";

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const PUSH_SUBSCRIPTION = process.env.PUSH_SUBSCRIPTION;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

const VAPID_PUBLIC_KEY =
  "BFHwW4fAJK_n6KbbnGKY-ozxPGcZFl6A413YbtoIcFl35Rxw8jomywghvSZyOhR17hLvEU4fzCrS_21dF-yHA68";

const WEB_APP_URL =
  "https://kabu-rashinban.github.io/kabu-rashinban-web/";

if (!DASHBOARD_TOKEN) throw new Error("DASHBOARD_TOKEN がありません");
if (!PUSH_SUBSCRIPTION) throw new Error("PUSH_SUBSCRIPTION がありません");
if (!VAPID_PRIVATE_KEY) throw new Error("VAPID_PRIVATE_KEY がありません");

const subscription = JSON.parse(PUSH_SUBSCRIPTION);

webpush.setVapidDetails(
  WEB_APP_URL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const ghHeaders = {
  "Accept": "application/vnd.github+json",
  "Authorization": `Bearer ${DASHBOARD_TOKEN}`,
  "User-Agent": "kabu-rashinban-alert-bot/1.0",
  "X-GitHub-Api-Version": "2022-11-28",
};

function contentsUrl(path) {
  return `https://api.github.com/repos/${OWNER}/${DASHBOARD_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
}

async function githubGetJson(path) {
  const res = await fetch(
    `${contentsUrl(path)}?ref=${encodeURIComponent(BRANCH)}`,
    { headers: ghHeaders }
  );

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new Error(
      `GitHub GET ${path}: ${res.status} ${await res.text()}`
    );
  }

  const data = await res.json();

  const text = Buffer.from(
    data.content.replace(/\n/g, ""),
    "base64"
  ).toString("utf8");

  return {
    json: JSON.parse(text),
    sha: data.sha,
  };
}

async function githubPutJson(path, value, sha, message) {
  const content = Buffer.from(
    JSON.stringify(value, null, 2) + "\n",
    "utf8"
  ).toString("base64");

  const body = {
    message,
    content,
    branch: BRANCH,
  };

  if (sha) body.sha = sha;

  const res = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: {
      ...ghHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `GitHub PUT ${path}: ${res.status} ${await res.text()}`
    );
  }
}

function normalizeTdnetItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map((item) => {
      if (
        item &&
        item.Tdnet &&
        typeof item.Tdnet === "object"
      ) {
        return item.Tdnet;
      }

      return item;
    })
    .filter(Boolean);
}

function irKey(item) {
  return String(
    item.id ||
    item.document_url ||
    `${item.pubdate || ""}|${item.title || ""}`
  );
}

function isImportantIr(title) {
  const words = [
    "上方修正",
    "下方修正",
    "業績予想",
    "自己株式",
    "自社株買い",
    "増配",
    "減配",
    "資本業務提携",
    "M&A",
    "子会社化",
    "株式取得",
    "第三者割当",
    "新株予約権",
    "決算短信",
    "業務提携",
    "受注",
  ];

  return words.some((word) =>
    String(title || "").includes(word)
  );
}

async function fetchCompanyIr(code) {
  const url =
    `https://webapi.yanoshin.jp/webapi/tdnet/list/${encodeURIComponent(code)}.json2?limit=20`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "kabu-rashinban-alert-bot/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`TDnet ${code}: ${res.status}`);
  }

  const data = await res.json();

  return normalizeTdnetItems(data.items);
}

async function fetchStock(code) {
  const url =
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}.T?range=1d&interval=1m&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo ${code}: ${res.status}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];

  if (!result) return null;

  const meta = result.meta || {};
  const timestamps = result.timestamp || [];

  const closes =
    result?.indicators?.quote?.[0]?.close || [];

  let lastPrice = null;
  let lastTs = null;

  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      lastPrice = Number(closes[i]);
      lastTs = timestamps[i];
      break;
    }
  }

  if (lastPrice == null) return null;

  const previousClose = Number(
    meta.previousClose ??
    meta.chartPreviousClose ??
    lastPrice
  );

  const changePct = previousClose
    ? ((lastPrice - previousClose) / previousClose) * 100
    : 0;

  return {
    price: lastPrice,
    previousClose,
    changePct,
    ts: lastTs,
  };
}

async function sendPush(
  title,
  body,
  url = WEB_APP_URL
) {
  const payload = JSON.stringify({
    title,
    body,
    url,
  });

  const result =
    await webpush.sendNotification(
      subscription,
      payload
    );

  console.log(
    `Push sent (${result.statusCode}): ${title}`
  );
}

function jstDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function cleanNumber(value, fallback = null) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

async function main() {
  const watchlistFile =
    await githubGetJson(WATCHLIST_PATH);

  if (!watchlistFile) {
    throw new Error(
      "watchlist.json が見つかりません"
    );
  }

  const watchlist =
    watchlistFile.json || {};

  const stateFile =
    await githubGetJson(STATE_PATH);

  const state =
    stateFile?.json || {
      version: 1,
      codes: {},
    };

  if (
    !state.codes ||
    typeof state.codes !== "object"
  ) {
    state.codes = {};
  }

  let stateChanged = false;

  const today =
    jstDateString();

  const activeCodes =
    new Set(Object.keys(watchlist));

  for (
    const code of Object.keys(state.codes)
  ) {
    if (!activeCodes.has(code)) {
      delete state.codes[code];
      stateChanged = true;
    }
  }

  for (
    const [code, cfgRaw]
    of Object.entries(watchlist)
  ) {
    const cfg = cfgRaw || {};

    const name =
      String(cfg.name || code);

    const target1 =
      cleanNumber(cfg.target1);

    const target2 =
      cleanNumber(cfg.target2);

    const pct =
      cleanNumber(cfg.pct, 5.0);

    let stock = null;
    let irItems = [];

    try {
      stock =
        await fetchStock(code);
    } catch (e) {
      console.error(
        `株価取得失敗 ${code}:`,
        e.message
      );
    }

    try {
      irItems =
        await fetchCompanyIr(code);
    } catch (e) {
      console.error(
        `IR取得失敗 ${code}:`,
        e.message
      );
    }

    let s =
      state.codes[code];

    if (!s) {
      s = {
        name,
        latest_ir_key:
          irItems[0]
            ? irKey(irItems[0])
            : null,

        target1_value: target1,

        target1_notified:
          stock &&
          target1 != null
            ? stock.price >= target1
            : false,

        target2_value: target2,

        target2_notified:
          stock &&
          target2 != null
            ? stock.price >= target2
            : false,

        pct_value: pct,
        pct_date: today,

        pct_notified:
          stock
            ? stock.changePct >= pct
            : false,
      };

      state.codes[code] = s;
      stateChanged = true;

      console.log(
        `初期化: ${code} ${name}`
      );

      continue;
    }

    if (s.name !== name) {
      s.name = name;
      stateChanged = true;
    }

    if (irItems.length > 0) {
      const latestKey =
        irKey(irItems[0]);

      if (!s.latest_ir_key) {
        s.latest_ir_key =
          latestKey;

        stateChanged = true;

      } else if (
        latestKey !== s.latest_ir_key
      ) {
        const newItems = [];

        for (const item of irItems) {
          const key = irKey(item);

          if (
            key === s.latest_ir_key
          ) {
            break;
          }

          newItems.push(item);
        }

        const toNotify =
          newItems.length === irItems.length
            ? newItems.slice(0, 1)
            : newItems.reverse();

        for (
          const item of toNotify
        ) {
          const titleText =
            String(
              item.title || "新着IR"
            );

          const important =
            isImportantIr(titleText);

          await sendPush(
            important
              ? `🔥 ${code} ${name}｜重要IR`
              : `📣 ${code} ${name}｜新着IR`,

            titleText,

            item.document_url ||
              WEB_APP_URL
          );
        }

        s.latest_ir_key =
          latestKey;

        stateChanged = true;
      }
    }

    if (!stock) {
      continue;
    }

    if (
      s.target1_value !== target1
    ) {
      s.target1_value =
        target1;

      s.target1_notified =
        false;

      stateChanged = true;
    }

    if (
      target1 != null &&
      !s.target1_notified &&
      stock.price >= target1
    ) {
      await sendPush(
        `🎯 ${code} ${name}｜第1目標到達`,
        `現在 ${stock.price.toFixed(0)}円 / 目標 ${target1.toFixed(0)}円`
      );

      s.target1_notified =
        true;

      stateChanged = true;
    }

    if (
      s.target2_value !== target2
    ) {
      s.target2_value =
        target2;

      s.target2_notified =
        false;

      stateChanged = true;
    }

    if (
      target2 != null &&
      !s.target2_notified &&
      stock.price >= target2
    ) {
      await sendPush(
        `🏁 ${code} ${name}｜第2目標到達`,
        `現在 ${stock.price.toFixed(0)}円 / 目標 ${target2.toFixed(0)}円`
      );

      s.target2_notified =
        true;

      stateChanged = true;
    }

    if (
      s.pct_value !== pct
    ) {
      s.pct_value = pct;

      s.pct_notified =
        false;

      stateChanged = true;
    }

    if (
      s.pct_date !== today
    ) {
      s.pct_date = today;

      s.pct_notified =
        false;

      stateChanged = true;
    }

    if (
      !s.pct_notified &&
      stock.changePct >= pct
    ) {
      await sendPush(
        `🚨 ${code} ${name}｜前日比 +${pct.toFixed(1)}%超`,
        `現在 ${stock.price.toFixed(0)}円 / 前日比 +${stock.changePct.toFixed(2)}%`
      );

      s.pct_notified =
        true;

      stateChanged = true;
    }
  }

  if (stateChanged) {
    await githubPutJson(
      STATE_PATH,
      state,
      stateFile?.sha || null,
      "Update alert state"
    );

    console.log(
      "alert state を保存しました"
    );

  } else {
    console.log(
      "新着・状態変更なし"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
