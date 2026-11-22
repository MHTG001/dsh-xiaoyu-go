import {openBrowserLogin} from './browser-login.js';
import {CloudError} from './cloud.js';

const copy = {
  loading: ['正在读取账号状态', 'Loading account', '正在检查本机登录和授权。', 'Checking local sign-in and access.'],
  signin: ['尚未登录', 'Signed out', '请在陌海官方页面登录并确认连接，完成后回到 DSH-Go。', 'Sign in and confirm the connection on Mohai, then return to DSH-Go.'],
  authorizing: ['等待浏览器授权', 'Waiting for browser', '在浏览器完成授权后，这里会自动更新。', 'This screen updates after you authorize in your browser.'],
  ready: ['已登录 · 本机已绑定', 'Signed in · Device linked', '可以回到对话开启「呼叫小鱼」。', 'Return to a chat and turn on Xiaoyu.'],
  unbound: ['已登录 · 本机待绑定', 'Signed in · Device unlinked', '首次使用需要绑定本机。', 'Link this device before using Xiaoyu.'],
  other: ['已登录 · 绑定在其他设备', 'Signed in · Another device linked', '请先解除旧设备的绑定，再刷新状态。', 'Unlink the previous device, then refresh.'],
  denied: ['已登录 · 订阅不可用', 'Signed in · Subscription unavailable', '开通或续期后，点「刷新状态」重新检查。', 'Activate or renew your subscription, then refresh.'],
  expired: ['浏览器授权超时', 'Browser sign-in expired', '请重新打开登录页面。', 'Open the sign-in page again.'],
  limited: ['请求太频繁', 'Too many requests', '请稍等，再刷新状态或重试登录。', 'Wait a moment, then refresh or sign in again.'],
  invalid: ['账号校验未完成', 'Account verification failed', '请刷新状态或重新登录。', 'Refresh or sign in again.'],
  unavailable: ['暂时无法连接陌海', 'Cannot reach Mohai', '请检查网络后重试。', 'Check your connection and try again.'],
};

export function accountPanel(cloud, notify, resetSessions) {
  let kind = 'loading';
  let hasAccount = false;
  let flow;
  let revision = 0;
  let busy = false;
  let alive = true;

  function update(next, signedIn = hasAccount) {
    if (!alive) return;
    kind = next;
    hasAccount = signedIn;
    notify();
  }

  function failure(error) {
    const next = error instanceof CloudError && Object.hasOwn(copy, error.kind)
      ? error.kind : 'unavailable';
    if (next === 'signin') resetSessions();
    update(next, next !== 'signin' && hasAccount);
  }

  async function refresh(signal) {
    if (!alive || flow || busy) return;
    const pending = ++revision;
    try {
      const account = await cloud.current();
      if (revision !== pending) return;
      hasAccount = true;
      const access = await cloud.status(account, signal);
      if (revision !== pending || signal?.aborted) return;
      update(!access.entitled ? 'denied' : access.binding === 'current' ? 'ready' : access.binding);
    } catch (error) {
      if (revision === pending && !signal?.aborted) failure(error);
    }
  }

  async function login(_scope, event) {
    if (!alive || busy) return;
    if (!flow) {
      revision++;
      flow = openBrowserLogin({
        accept: (tokens, signal) => cloud.acceptSession(tokens, signal),
        finish(error) {
          flow = undefined;
          if (!alive) return;
          if (error?.kind === 'cancelled') {
            void refresh();
          } else if (error) {
            failure(error);
          } else {
            resetSessions();
            update('loading', true);
            void refresh();
          }
        },
      });
      update('authorizing');
    }
    try {
      const attempt = flow;
      const url = await attempt.url;
      if (flow === attempt) return {link: url};
    } catch {
      return {toast: String(event?.locale).startsWith('en') ? 'Could not open sign-in' : '暂时无法打开登录界面'};
    }
  }

  function deferred(zh, en, action) {
    return (_scope, event) => {
      const english = String(event?.locale).startsWith('en');
      return {
        pending: {label: english ? en : zh, timeoutMs: 45_000},
        result: signal => action(signal, english),
      };
    };
  }

  const actions = {
    login,
    cancelLogin() { flow?.cancel(); },
    refresh: deferred('刷新账号状态', 'Checking account', signal => refresh(signal)),
    bind: deferred('正在绑定本机', 'Linking device', async (signal, en) => {
      if (busy || flow) return;
      busy = true;
      revision++;
      try {
        const account = await cloud.current();
        await cloud.bind(account, signal);
        signal.throwIfAborted();
        update('ready', true);
        return {toast: en ? 'Device linked' : '本机绑定成功'};
      } catch (error) {
        if (!signal.aborted) failure(error);
      } finally {
        busy = false;
      }
    }),
    logout: deferred('正在退出登录', 'Signing out', async (_signal, en) => {
      if (busy || flow) return;
      busy = true;
      revision++;
      try {
        await cloud.logout();
        resetSessions();
        update('signin', false);
        return {toast: en ? 'Signed out' : '已退出陌海账号'};
      } catch (error) {
        failure(error);
      } finally {
        busy = false;
      }
    }),
  };

  function data(en) {
    const t = (zh, english) => en ? english : zh;
    const button = (action, zh, english, style = 'plain', icon = 'account') =>
      ({action, label: t(zh, english), icon, style});
    const [statusZh, statusEn, hintZh, hintEn] = copy[kind];
    let buttons;
    if (kind === 'authorizing') {
      buttons = [
        button('login', '打开授权页', 'Open browser', 'primary', 'external'),
        button('cancelLogin', '取消授权', 'Cancel'),
      ];
    } else if (!hasAccount && kind !== 'loading') {
      buttons = [button('login', '登录陌海账号', 'Sign in to Mohai', 'primary', 'external')];
    } else if (kind === 'unbound') {
      buttons = [
        button('bind', '绑定本机', 'Link device', 'primary', 'phone'),
        button('logout', '退出登录', 'Sign out'),
      ];
    } else {
      buttons = [button('refresh', '刷新状态', 'Refresh', 'plain', 'refresh')];
      if (hasAccount && kind !== 'loading') buttons.push(button('logout', '退出登录', 'Sign out'));
    }
    return {accountStatus: t(statusZh, statusEn), accountHint: t(hintZh, hintEn), accountActions: buttons};
  }

  return {
    get kind() { return kind; },
    actions, data, refresh,
    dispose() {
      alive = false;
      revision++;
      flow?.cancel();
    },
  };
}
