const fs = require('fs');
const path = require('path');
const YAML = require('yamljs');
const { exec } = require('child_process');
const axios = require('axios');

// 下载文件函数
async function downloadFile (url, directory, index) {
    try {
        const urlParts = url.split('/');
        let fileName = urlParts[urlParts.length - 1].trim();
        if (!fileName) fileName = `file_${index}`;

        let filePath = path.join(directory, fileName);
        let counter = 1;
        while (fs.existsSync(filePath)) {
            const ext = path.extname(fileName);
            const baseName = path.basename(fileName, ext);
            filePath = path.join(directory, `${baseName}_${counter}${ext}`);
            counter++;
        }

        console.log(`开始下载: ${url} -> ${filePath}`);
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`文件下载完成: ${filePath}`);
    } catch (error) {
        console.error(`下载失败: ${url} -> ${error.message}`);
    }
}

// 下载配置文件
async function downloadConfigFile () {
    const urlFilePath = path.join(__dirname, 'url.txt');
    const downloadDirectory = path.join(__dirname, 'urlConfig');
    if (!fs.existsSync(downloadDirectory)) fs.mkdirSync(downloadDirectory, { recursive: true });

    return new Promise((resolve, reject) => {
        fs.readFile(urlFilePath, 'utf8', async (err, data) => {
            if (err) {
                console.error('读取 URL 文件失败:', err);
                reject(err);
                return;
            }

            const urls = data.split('\n').map(line => line.trim()).filter(line => line !== '');
            console.log(`发现 ${urls.length} 个 URL，开始下载...`);
            const downloadPromises = urls.map((url, index) => downloadFile(url, downloadDirectory, index));
            await Promise.all(downloadPromises);
            console.log('所有文件下载完成');
            resolve(downloadDirectory);
        });
    });
}

// 读取并解析 YAML 文件，返回代理数组
function readYamlFilesFromDirectory (directoryPath) {
    return new Promise((resolve) => {
        const allProxies = new Map();
        fs.readdir(directoryPath, (err, files) => {
            if (err) {
                console.error('读取目录失败:', err);
                resolve([]);
                return;
            }

            const yamlFiles = files.filter(file => file.endsWith('.yaml'));
            console.log(`读取目录: ${directoryPath}, 找到 ${yamlFiles.length} 个 YAML 文件`);

            yamlFiles.forEach((file) => {
                const filePath = path.join(directoryPath, file);
                const config = YAML.load(filePath);

                if (config.proxies && Array.isArray(config.proxies)) {
                    config.proxies.forEach((proxy) => {
                        if (proxy.name && !allProxies.has(proxy.name)) {
                            allProxies.set(proxy.name, proxy);
                        }
                    });
                }
            });

            resolve(Array.from(allProxies.values()));
        });
    });
}

// 启动 Clash 服务

function startClash () {
    const clashPath = path.join(__dirname, 'clash.exe');
    const configPath = path.join(__dirname, 'config.yaml');

    // 打印路径，检查是否正确
    console.log(`Clash Path: ${clashPath}`);
    console.log(`Config Path: ${configPath}`);

    // 启动 Clash
    const clash = exec(`"${clashPath}" -f "${configPath}"`, (err, stdout, stderr) => {
        // 打印错误、标准输出和标准错误
        console.log(err, stdout, stderr, 'err, stdout, stderr');

        if (err) {
            console.error(`启动 Clash 时出错: ${err}`);
            return false;
        }
        if (stderr) {
            console.error(`Clash 错误输出: ${stderr}`);
            return
        } else {
            console.log(`Clash 启动成功: ${stdout}`);

        }
    });

    // 此处 console.log(clash) 只是返回一个子进程对象
    // 可以打印 clash 对象进行调试，但不会立即输出 stdout 或 stderr
    // console.log(clash);
}



// 进行代理检测
async function performTests (proxies) {
    const validProxies = [];
    const invalidProxies = [];

    const maxConcurrentRequests = 50;
    const delayBetweenRequests = 200;

    const testProxy = async (proxy) => {
        const proxyName = encodeURIComponent(proxy.name);
        const urlTemplate = `http://127.0.0.1:7600/proxies/${proxyName}/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000`;

        // 调试信息
        // console.log(`正在测试代理: ${proxy.name}`);

        try {
            const response = await axios.get(urlTemplate);
            const delay = response.data.delay;

            if (typeof delay === 'number' && !isNaN(delay)) {
                // 输出绿色文本，表示成功
                console.log(`\x1b[32m代理 ${proxy.name} 延迟: ${delay}ms (有效)\x1b[0m`);
                validProxies.push(proxy);
            } else {
                // 输出灰色文本，表示延迟无效
                console.log(`\x1b[90m代理 ${proxy.name} 延迟无效\x1b[0m`);
                invalidProxies.push(proxy);
            }
        } catch (error) {
            // 输出灰色文本，表示请求失败
            console.error(`\x1b[90m代理 ${proxy.name} 请求失败: ${error.message}\x1b[0m`);

            // 如果错误包含'connect ECONNREFUSED 127.0.0.1:7600',则禁止
            if (error.message.includes('connect ECONNREFUSED 127.0.0.1:7600')) {
                console.log('Clash 未启动，请先启动 Clash');
            }
            invalidProxies.push(proxy);
        }
    };


    for (let i = 0; i < proxies.length; i += maxConcurrentRequests) {
        const batch = proxies.slice(i, i + maxConcurrentRequests);
        await Promise.all(batch.map(proxy => testProxy(proxy)));

        if (i + maxConcurrentRequests < proxies.length) {
            console.log(`等待 ${delayBetweenRequests} 毫秒再发送下一批请求...`);
            await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
        }
    }

    console.log(`有效代理: ${validProxies.length}, 无效代理: ${invalidProxies.length}`);

    if (validProxies.length > 0) {
        const updatedConfig = {
            mode: "rule",
            "redir-port": 7000,
            "mixed-port": 7500,
            "allow-lan": true,
            "log-level": "info",
            "external-controller": "127.0.0.1:7600",
            proxies: validProxies
        };
        const outputPath = path.join(__dirname, 'config.yaml');
        fs.writeFileSync(outputPath, YAML.stringify(updatedConfig, 6, 2));
        console.log(`更新后的配置已保存到: ${outputPath}`);
    } else {
        console.log('没有有效的代理，未生成新的配置文件');
    }
}

// 主流程控制函数
async function main () {
    try {


        // 2. 下载文件
        const downloadDirectory = await downloadConfigFile();

        // 3. 读取下载目录的 YAML 文件
        const downloadedProxies = await readYamlFilesFromDirectory(downloadDirectory);

        // 4. 读取本地目录的 YAML 文件
        const localDirectory = path.join(__dirname, 'config');
        const localProxies = await readYamlFilesFromDirectory(localDirectory);

        // 5. 合并去重
        const allProxies = new Map();
        [...downloadedProxies, ...localProxies].forEach(proxy => {
            if (proxy.name && !allProxies.has(proxy.name)) {
                allProxies.set(proxy.name, proxy);
            }
        });

        const mergedProxies = Array.from(allProxies.values());
        console.log(`合并后的代理节点数量: ${mergedProxies.length}`);

        // 6. 保存合并后的配置
        const mergedConfig = {
            mode: "rule",
            "redir-port": 7000,
            "mixed-port": 7500,
            "allow-lan": true,
            "log-level": "info",
            "external-controller": "127.0.0.1:7600",
            proxies: mergedProxies,
        };

        const outputPath = path.join(__dirname, 'config.yaml');
        fs.writeFileSync(outputPath, YAML.stringify(mergedConfig, 6, 2));
        console.log(`合并后的配置已保存到: ${outputPath}`);

        // 1. 启动 Clash 服务
        await startClash();


        // 7. 进行有效性检测
        await performTests(mergedProxies);



        // 启动http服务器，将clash配置文件作为静态资源返回

        const express = require('express');
        const app = express();
        const port = 7800;
        app.use(express.static(__dirname));
        app.listen(port, () => {
            console.log(`\x1b[32mClash配置文件已保存，正在监听端口 ${port}\x1b[0m`);
            console.log(`\x1b[32m请订阅：http://127.0.0.1:7800/config.yaml\x1b[0m`);
            console.log(`\x1b[32m本地地址：${__dirname}/config.yaml\x1b[0m`);
        });


    } catch (error) {
        console.error('流程执行失败:', error.message);
    }
}

main();
// startClash();
