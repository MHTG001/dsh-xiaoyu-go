import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {CloudPrompts, dataDirectory} from './cloud.js';

const command = process.argv[2];
const cloud = new CloudPrompts(dataDirectory());
const errors = {
  signin: '登录失败或已过期。请检查账号密码。',
  unavailable: '连接 formohai.top 失败，请稍后重试。',
  denied: '订阅无效或服务拒绝授权。请先确认账户状态。',
  other: '此账号已绑定其他设备，请走现有解绑流程。',
  twofactor: '此账号要求二次验证，当前手机插件的终端登录暂不支持。',
  invalid: '账户或设备信息校验失败。',
};
let terminal;
let silent = false;

try {
  if (process.argv.length !== 3 || !['login', 'bind', 'status', 'logout'].includes(command)) {
    throw new Error('用法：node lib/account-cli.js login|bind|status|logout');
  }
  if (command === 'logout') {
    await cloud.logout();
    console.log('本机已退出。');
  } else {
    if (command === 'login' || command === 'bind') {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在 DSH-Go 本机交互终端运行。');
      const output = new Writable({write(chunk, _encoding, callback) {
        if (!silent) process.stdout.write(chunk);
        callback();
      }});
      output.isTTY = true;
      output.columns = process.stdout.columns;
      terminal = createInterface({input: process.stdin, output, terminal: true, historySize: 0});
      terminal.on('SIGINT', () => { terminal.close(); process.exitCode = 130; });
    }
    if (command === 'login') {
      const email = (await terminal.question('陌海邮箱：')).trim();
      if (!email || email.length > 254) throw new Error('请输入有效邮箱。');
      process.stdout.write('陌海密码（隐藏输入）：');
      silent = true;
      let password;
      try {
        password = await terminal.question('');
      } finally {
        silent = false;
        process.stdout.write('\n');
      }
      if (!password || password.length > 1024) throw new Error('密码为空或过长。');
      await cloud.login(email, password);
      password = '';
      console.log('登录成功。');
    } else if (command === 'bind') {
      const account = await cloud.current();
      const answer = (await terminal.question('确认绑定这台设备？输入 yes 确认：')).trim();
      if (answer === 'yes') {
        await cloud.bind(account);
        console.log('当前设备已绑定。');
      }
    } else {
      const status = await cloud.status(await cloud.current());
      console.log(status.entitled ? '订阅有效。' : '订阅无效。');
      console.log({unbound: '尚未绑定设备。', current: '当前设备已绑定。', other: '账号已绑定其他设备。'}[status.binding]);
    }
  }
} catch (error) {
  if (process.exitCode !== 130) {
    console.error(errors[error.kind] || (error.code ? '本机账户文件操作失败。' : '操作未完成，请检查本机账户和网络。'));
    process.exitCode = 1;
  }
} finally {
  terminal?.close();
}
