// 开发工具：看一个 UID 的主页，打印她会看到的那段话和记进记忆的那句。
import { fetchProfile, profileSummary, profileText } from '../packages/dsh-livestream/src/body/biliProfile';
for (const uid of process.argv.slice(2)) {
  const p = await fetchProfile(uid);
  console.log(p ? `${profileText(p, '舰长，粉丝牌25级')}\n记忆：${profileSummary(p)}\n` : `${uid}：没拿到`);
}
