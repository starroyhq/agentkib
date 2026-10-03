/**
 * 从 agent 输出的 markdown 中提取链接和图片的目标地址，用于在会话里找出可预览的产物。
 *
 * runtime 的会话事件只有纯文本 content，没有结构化的链接字段，所以只能解析 markdown。
 * 这里不追求完整的 CommonMark：只处理 `[text](target)`、`![alt](target)`、`<target>`
 * 形式的尖括号目标、可选标题，以及目标里一层成对的括号。代码块和行内代码中的内容会被
 * 跳过，避免把示例代码里的路径当成产物。返回值只是候选，调用方仍需按授权范围逐个校验。
 */
export function markdownLinkTargets(content: string): string[] {
  return [...prose(content).matchAll(LINK)].flatMap((match) => {
    const target = match[1] ?? match[2];
    return target ? [target] : [];
  });
}

// 目标允许一层成对括号，例如 `report(1).png`；标题支持双引号、单引号和括号三种写法。
const LINK =
  /!?\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^<>\n]+)>|((?:[^\s()\\]|\\.|\([^\s()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** 去掉围栏代码块和行内代码，只保留正文。 */
function prose(content: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      // 只有同种字符、长度不短于开头的围栏才能闭合代码块。
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) fence = marker;
    else lines.push(line);
  }
  // 行内代码：成对的等长反引号之间的内容不参与匹配。
  return lines.join("\n").replace(/(`+)[^`]*?\1/g, " ");
}
