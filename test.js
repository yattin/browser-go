// playwright-extra is a drop-in replacement for playwright,
// it augments the installed playwright with plugin functionality


import { chromium } from 'patchright';
import * as dotenv from 'dotenv'
dotenv.config()

const launchArgs = JSON.stringify(
    {
        user: "test",
        args: ["--window-size=1440,900"]
    }
);

const startingUrl = "https://www.baidu.com";

// 从环境变量读取 token
const token = process.env.TOKEN;

const cdpUrl = `ws://127.0.0.1:3000/?startingUrl=${encodeURIComponent(startingUrl)}&token=${token}&launch=${encodeURIComponent(launchArgs)}`;

chromium.connectOverCDP(cdpUrl).then(async browser => {

    console.log('浏览器初始化完成....')

    const context = await browser.contexts()[0]

    const pages = context.pages()

    const page = pages[0]

    await page.goto("https://www.baidu.com/s?wd=%E9%A9%AC%E4%BA%91%E5%9B%9E%E5%BA%94%E5%9B%9E%E5%BD%92%E9%98%BF%E9%87%8C%E4%BC%A0%E9%97%BB", { waitUntil: "networkidle" })

    console.log('浏览器执行完成....')

})
