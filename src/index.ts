import { Context, Logger, Schema, Session } from "koishi";
import type { LarkBot } from "@koishijs/plugin-adapter-lark";
import fs from "fs";
import path from "path";

export const Config = Schema.object({
  apiUrl: Schema.string()
    .description("API URL")
    .default("https://api.openai.com/v1/chat/completions"),
  apiKey: Schema.string().required().role("secret").description("API Key"),
  model: Schema.union([
    // GPT-3.5 Models
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-16k-0613",

    // GPT-4 Models
    "gpt-4-0125-preview",
    "gpt-4-turbo-preview",
    "gpt-4-1106-preview",
    "gpt-4-vision-preview",
    "gpt-4-1106-vision-preview",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-32k",
    "gpt-4-32k-0613",
  ])
    .description("语言模型")
    .default("gpt-3.5-turbo"),
  customModel: Schema.string().description(
    "自定义模型(如果存在会优先使用，否则使用选择的 model)"
  ),
  systemPrompt: Schema.string().role("textarea").description("系统提示"),
  helpMessage: Schema.string().role("textarea").description("帮助信息"),
  temperature: Schema.number()
    .description("回复温度，越高越随机")
    .min(0)
    .max(2)
    .step(0.1)
    .default(0.5),
  presencePenalty: Schema.number()
    .description("重复惩罚，越高越不易重复出现过至少一次的Token")
    .min(-2)
    .max(2)
    .step(0.1)
    .default(0.0),
  frequencyPenalty: Schema.number()
    .description("频率惩罚，越高越不易重复出现次数较多的Token")
    .min(-2)
    .max(2)
    .step(0.1)
    .default(0.0),
  maxTokens: Schema.number()
    .description("最长能记忆的Token数(不精确）")
    .min(16)
    .max(4096)
    .step(1)
    .default(3000),
  memoryDir: Schema.string()
    .description("记忆文件的路径")
    .default("./contexts"),
}).description("配置");

export type Config = Schemastery.TypeT<typeof Config>;
const DBTableName = "ai_chat_token_usage";

declare module "koishi" {
  interface Tables {
    [DBTableName]: AIChatTokenUsage;
  }
}

export interface AIChatTokenUsage {
  id: string;
  userName: string;
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
  remark: string;
}

interface Message {
  role: string;
  content: string;
}

export const name = "ai-chat";
export const inject = ["database"];
const logger = new Logger(name);

export function apply(ctx: Context, config: Config) {
  ctx.model.extend(DBTableName, {
    id: "string",
    userName: "string",
    completionTokens: "integer",
    promptTokens: "integer",
    totalTokens: "integer",
    remark: "string",
  });

  const contextDir = path.join(ctx.baseDir, "data", name, config.memoryDir);
  if (!fs.existsSync(contextDir)) {
    fs.mkdirSync(contextDir, { recursive: true });
  }
  logger.debug(`上下文目录: ${contextDir}`);

  ctx.command(commandName("reset")).action(async ({ session }) => {
    resetContext(session.userId);
    await session.send("✨ 咔嚓！对话已经闪亮重置，就像新的魔法卷轴一样呢！");
  });

  ctx.command(commandName("help")).action(async ({ session }) => {
    await session.send(config.helpMessage);
  });

  const activeChats = new Map<string, boolean>();
  ctx.middleware(async (session, next) => {
    if (ctx.bots[session.userId]) return next(); // 忽略来自自身的消息

    // 检查用户是否已经有一个正在进行的聊天API任务
    if (activeChats.get(session.userId)) {
      // 如果有，返回提示信息
      session.send(
        "🌟 嘘~你的魔法正在精心准备中，请给我一点时间让它完美呈现。一条接一条，别急嘛~"
      );
      return;
    }
    // 标记该用户有一个活跃的聊天API任务
    activeChats.set(session.userId, true);

    const input = session.content.trim().replace(/<[^>]*>/g, ""); // 去除XML元素
    if (input === "") return next(); // 忽略空消息

    const response = await chat(session, input);

    activeChats.delete(session.userId);
    session.send(
      response ||
        "哦哦，施法过程中似乎有点小小的波折🌀。稍等片刻，让我再次集中魔力尝试~"
    );
  });

  function saveContext(uid: string, context: Message[]): void {
    const contextPath = path.join(contextDir, `${uid}.json`);
    fs.writeFileSync(contextPath, JSON.stringify(context));
  }

  function loadContext(uid: string): Message[] {
    const contextPath = path.join(contextDir, `${uid}.json`);
    if (fs.existsSync(contextPath)) {
      return JSON.parse(fs.readFileSync(contextPath, "utf8"));
    }
    return [];
  }

  function resetContext(uid: string) {
    const contextPath = path.join(contextDir, `${uid}.json`);
    try {
      if (fs.existsSync(contextPath)) {
        fs.unlinkSync(contextPath); // 尝试删除文件以重置上下文
        logger.debug(`上下文成功重置: ${contextPath}`);
      } else {
        logger.debug(`未找到上下文文件: ${contextPath}`);
      }
    } catch (error) {
      logger.error(`重置上下文时发生错误:`, error);
    }
  }

  function truncateContextIfNeeded(
    context: Message[],
    maxTokens: number
  ): Message[] {
    let truncatedContext = [...context];
    while (
      truncatedContext.reduce((acc, curr) => acc + curr.content.length, 0) >
      maxTokens
    ) {
      truncatedContext.shift();
    }
    logger.debug(
      `截断后的上下文全部内容长度: ${truncatedContext.reduce(
        (acc, curr) => acc + curr.content.length,
        0
      )}`
    );
    return truncatedContext;
  }

  async function chat(session: Session, content: string): Promise<string> {
    const uid = session.userId;
    let context = loadContext(uid);

    // 移除现有的 systemPrompt，如果存在
    if (context.length > 0 && context[0].role === "system") {
      context.shift();
    }
    context.push({ role: "user", content });
    context = truncateContextIfNeeded(context, config.maxTokens);

    // 在截断处理后，将 config.systemPrompt 加到上下文的开头
    if (config.systemPrompt) {
      context.unshift({
        role: "system",
        content: `${config.systemPrompt}\n\n`,
      });
    }

    const body = JSON.stringify({
      model: config.customModel || config.model,
      messages: context,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      frequency_penalty: config.frequencyPenalty,
      presence_penalty: config.presencePenalty,
    });

    logger.debug(`发送请求: ${body}`);

    try {
      const response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
      });

      if (!response.ok) {
        throw new Error(
          `API请求失败，状态码：${response.status}, ${response.statusText}`
        );
      }

      const data = await response.json();
      logger.debug(`收到回复: ${JSON.stringify(data)}`);

      updateTokenUsage(session, data.usage);

      const text = data.choices[0].message.content;

      // 保存对话上下文
      context.push({ role: "assistant", content: text });
      saveContext(uid, context);

      return text;
    } catch (error) {
      logger.error(`处理UID:${uid}的请求时发生错误:`, error);
      return ""; // 发生错误时返回null
    }
  }

  async function updateTokenUsage(
    session: Session,
    usage: {
      completion_tokens: number;
      prompt_tokens: number;
      total_tokens: number;
    }
  ): Promise<void> {
    try {
      const uid = session.userId;
      const existingUsage = (await ctx.database.get(DBTableName, uid))[0] || {
        userName: "",
        completionTokens: 0,
        promptTokens: 0,
        totalTokens: 0,
      };

      let userName = existingUsage.userName;
      if (userName === "") {
        if (session.username !== uid) {
          userName = session.username;
        } else if (session.platform === "lark") {
          const http = (session.bot as unknown as LarkBot).http;
          const res = await http(
            `https://open.feishu.cn/open-apis/contact/v3/users/${uid}`
          );
          const data = res.data;
          const userData = data.data.user;
          userName = `${userData.name}(${userData.nickname})`;
        }
      }

      const newUsage = {
        id: uid,
        userName,
        completionTokens:
          existingUsage.completionTokens + usage.completion_tokens,
        promptTokens: existingUsage.promptTokens + usage.prompt_tokens,
        totalTokens: existingUsage.totalTokens + usage.total_tokens,
      };

      logger.debug(`更新使用情况: ${JSON.stringify(newUsage, null, 2)}`);

      await ctx.database.upsert(DBTableName, [newUsage]);
    } catch (error) {
      logger.error(`更新Token使用情况时发生错误:`, error);
    }
  }
}

function commandName(command: string) {
  return `${name}.${command}`;
}
