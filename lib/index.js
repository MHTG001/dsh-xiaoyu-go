import {CloudPrompts, CloudError, dataDirectory} from './cloud.js';

export const inject = ['llm'];
const validSession = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const useEnglish = caps => String(caps?.locale || '').startsWith('en');
const localized = (en, zh, english) => en ? english : zh;
const modelId = value => String(value ?? '').trim().toLowerCase();
const describeError = error => error instanceof CloudError ? error.kind : 'unavailable';
const blocked = (model, provider) =>
  /(?:^|[/_-])(?:gpt(?:[-_\d]|$)|chatgpt|claude|o[134](?:[-_\s]|$))/i.test(model) &&
  !/^(openai|anthropic)$/i.test(provider);

const labels = {
  off: ['小鱼 · 已关闭', 'Xiaoyu · Off'],
  checking: ['小鱼 · 检查授权', 'Xiaoyu · Checking'],
  waiting: ['小鱼 · 等待模型请求', 'Xiaoyu · Waiting'],
  missing: ['小鱼 · 未匹配模型', 'Xiaoyu · No match'],
  blocked: ['小鱼 · 中转模型停用', 'Xiaoyu · Relay off'],
  signin: ['小鱼 · 请先登录', 'Xiaoyu · Sign in'],
  unbound: ['小鱼 · 请先绑定设备', 'Xiaoyu · Bind device'],
  other: ['小鱼 · 已绑定其他设备', 'Xiaoyu · Other device'],
  denied: ['小鱼 · 授权不可用', 'Xiaoyu · No entitlement'],
  limited: ['小鱼 · 请求过于频繁', 'Xiaoyu · Rate limited'],
  invalid: ['小鱼 · 校验失败', 'Xiaoyu · Invalid response'],
  unavailable: ['小鱼 · 云端暂不可用', 'Xiaoyu · Unavailable'],
};

export async function apply(ctx) {
  // The SDK checker loads the native UI without the host's LLM runtime.
  const engine = ctx.llm ? await import('@deepseek-ai/dsh-llm') : null;
  mount(ctx, engine, new CloudPrompts(dataDirectory()));
}

export function mount(ctx, engine, cloud) {
  const choices = new Map();
  const observed = new Map();
  const feeds = new Set();

  function status(id, en) {
    const state = observed.get(id);
    if (!state) return {text: labels.off[en ? 1 : 0], tone: 'muted'};
    if (state.kind === 'matched') {
      const word = state.word.replace(/\s+/g, ' ').trim();
      const label = en ? 'Xiaoyu · Matched' : '小鱼 · ' + (word || '已匹配');
      return {text: [...label].slice(0, 24).join(''), tone: 'good'};
    }
    const label = labels[state.kind] ?? labels.unavailable;
    const tone = ['off', 'checking', 'waiting'].includes(state.kind) ? 'muted' : 'warn';
    return {text: label[en ? 1 : 0], tone};
  }

  function publish(id) {
    for (const feed of feeds) if (feed.id === id) feed.update();
  }

  function update(id, state) {
    observed.delete(id);
    observed.set(id, state);
    if (observed.size > 256) {
      const oldest = observed.keys().next().value;
      observed.delete(oldest);
      publish(oldest);
    }
    publish(id);
  }

  function control(id, enabled, en) {
    if (!validSession(id)) return {toast: localized(en, '请先打开一个对话', 'Open a chat first')};
    if (!(enabled ?? !choices.has(id))) {
      choices.delete(id);
      update(id, {kind: 'off'});
      return {toast: localized(en, '呼叫小鱼已关闭', 'Xiaoyu off')};
    }
    if (!choices.has(id) && choices.size >= 256) {
      return {toast: localized(en, '已开启的对话过多', 'Too many active chats')};
    }

    const choice = {accountId: null};
    choices.set(id, choice);
    update(id, {kind: 'checking'});
    return {
      pending: {label: localized(en, '检查小鱼授权', 'Checking access'), timeoutMs: 30000},
      async result(signal) {
        let message;
        try {
          const account = await cloud.current();
          const access = await cloud.status(account, signal);
          signal?.throwIfAborted();
          if (!access.entitled) throw new CloudError('denied');
          if (access.binding !== 'current') throw new CloudError(access.binding);
          if (choices.get(id) !== choice) return;
          choice.accountId = account.id;
          update(id, {kind: 'waiting'});
          message = localized(en, '呼叫小鱼已开启', 'Xiaoyu on');
        } catch (error) {
          if (choices.get(id) !== choice) return;
          choices.delete(id);
          const kind = signal?.aborted ? 'off' : describeError(error);
          update(id, {kind});
          message = status(id, en).text;
        }
        return {toast: message};
      },
    };
  }

  if (engine) {
    const forwarded = new WeakSet();
    ctx.on('llm/stream', (request, next) => {
      const id = request.sessionId;
      if (forwarded.has(request) || !validSession(id) || !engine.isAgentLoopRequest(request)) return next();
      const choice = choices.get(id);
      const model = modelId(request.model);
      if (!choice?.accountId || !model) return next();
      if (blocked(model, request.provider)) {
        update(id, {kind: 'blocked', model});
        return next();
      }

      return (async function* () {
        let prompt;
        try {
          const account = await cloud.current();
          if (account.id !== choice.accountId) throw new CloudError('signin');
          prompt = await cloud.resolve(account, model, request.signal);
        } catch (error) {
          if (choices.get(id) === choice) {
            const kind = describeError(error);
            if (['signin', 'denied', 'other'].includes(kind)) choices.delete(id);
            update(id, {kind, model});
          }
        }

        if (!prompt || choices.get(id) !== choice || request.signal?.aborted) {
          yield* next();
          return;
        }
        update(id, {kind: 'matched', model, word: prompt.word});
        const system = engine.createSystemMessage(prompt.text);
        const messages = Object.freeze([system, ...request.messages.filter(message => message.role !== 'system')]);
        const candidate = engine.markAgentLoopRequest(Object.freeze({...request, messages}));
        forwarded.add(candidate);
        yield* ctx.llm.stream(candidate);
      })();
    });
  }

  ctx.inject(['dshGo'], bridge => {
    const go = bridge.dshGo;
    go.on('toggle', (scope, event) => control(scope.sessionId, undefined, useEnglish(event)));
    go.strip('status', (scope, emit, caps) => {
      const id = scope.sessionId;
      const feed = {id, update: () => emit(validSession(id) ? status(id, useEnglish(caps)) : null)};
      feed.update();
      feeds.add(feed);
      return () => feeds.delete(feed);
    });
    go.panel('prompts', {
      view(scope, caps) {
        const en = useEnglish(caps);
        const children = [];
        if (validSession(scope.sessionId)) {
          children.push(
            {type: 'text', text: {$: 'data.status'}},
            {type: 'text', text: {$: 'data.model'}, tone: 'muted'},
            {type: 'actions', items: [
              {label: localized(en, '开启', 'Enable'), action: 'enable'},
              {label: localized(en, '关闭', 'Disable'), action: 'disable'},
            ]},
          );
        }
        children.push({type: 'text', tone: 'muted', text: localized(en,
          '请先在 DSH-Go 本机终端登录陌海账号并绑定设备。', 'Sign in and bind this device in the DSH-Go local terminal.')});
        return {type: 'stack', children};
      },
      data(scope, emit, caps) {
        const id = scope.sessionId;
        const en = useEnglish(caps);
        const feed = {id, update() {
          const model = observed.get(id)?.model?.slice(0, 150) || localized(en, '暂未发送', 'None yet');
          emit({status: status(id, en).text, model: localized(en, '最近请求模型：', 'Last model: ') + model});
        }};
        feed.update();
        feeds.add(feed);
        return () => feeds.delete(feed);
      },
      actions: {
        enable: (scope, event) => control(scope.sessionId, true, useEnglish(event)),
        disable: (scope, event) => control(scope.sessionId, false, useEnglish(event)),
      },
    });
  });
}
