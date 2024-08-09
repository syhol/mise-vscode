// Import the module and reference it with the alias vscode in your code below
// The module 'vscode' contains the VS Code extensibility API
import * as vscode from "vscode";
import { ConfigurationTarget, workspace } from "vscode";
import { exec as callbackExec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { symlink, mkdir, readlink, access, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const exec = promisify(callbackExec);

const misePatterns = [
  ".config/mise/config.toml",
  "mise/config.toml",
  "mise.toml",
  ".mise/config.toml",
  ".mise.toml",
  ".config/mise/config.local.toml",
  "mise/config.local.toml",
  "mise.local.toml",
  ".mise/config.local.toml",
  ".mise.local.toml",
  ".config/mise/config.*.toml",
  "mise/config.*.toml",
  "mise.*.toml",
  ".mise/config.*.toml",
  ".mise.*.toml",
  ".config/mise/config.*.local.toml",
  "mise/config.*.local.toml",
  ".mise/config.*.local.toml",
  ".mise.*.local.toml",
].join(",");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Mise");
  context.subscriptions.push(outputChannel);
  const vscodeMise = new VSCodeMise(context, outputChannel);

  outputChannel.appendLine("mise-vscode is now active");

  vscodeMise.configurePaths();

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const configurePathsCommandHandler = vscode.commands.registerCommand(
    "mise-vscode.configurePaths",
    () => {
      vscodeMise.configurePaths();
    }
  );
  context.subscriptions.push(configurePathsCommandHandler);

  // const configuration = workspace.getConfiguration();
  // configuration
  //   .update("deno.path", "bar", ConfigurationTarget.Workspace)
  //   .then(() => {
  //     vscode.window.showInformationMessage("Updated Deno!");
  //   });

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const pattern = new vscode.RelativePattern(folder, `{${misePatterns}}`);
    const watcher = workspace.createFileSystemWatcher(pattern);

    function filesChanged(uri: vscode.Uri) {
      vscodeMise.configurePaths();
    }
    watcher.onDidChange(filesChanged); // listen to files being changed
    watcher.onDidCreate(filesChanged); // listen to files/folders being created
    watcher.onDidDelete(filesChanged); // listen to files/folders getting deleted

    context.subscriptions.push(watcher);
  }
}

class VSCodeMise {
  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel
  ) {}

  async configurePaths() {
    const tools = await this.getTools();

    await Promise.allSettled(
      tools.map(async (tool) => {
        await this.installTool(tool);
        console.log("Two", tool.name + " " + tool.version);
        await this.createSymlink(tool);
        console.log("Three");
        await this.updateConfig(tool);
      })
    );
  }

  async getTools() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const { stdout } = await exec("mise list --current --json", {
      cwd: folder?.uri.fsPath,
    });
    const rawTools = JSON.parse(stdout);
    const tools = [];
    for (const [toolName, toolVersions] of Object.entries(rawTools)) {
      const [tool] = toolVersions as any;
      if (!tool?.source?.path?.startsWith(folder?.uri.fsPath)) {
        continue;
      }
      tools.push({ name: toolName, ...tool });
    }
    return tools;
  }

  // @TODO need to implement something to
  // stop duplicate installs and installs
  // of different versions at the same time
  installsInFlight = {};

  async installTool(tool: any) {
    const toolName = `${tool.name}@${tool?.version}`;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (tool?.installed) {
      return;
    }
    const answer = await vscode.window.showInformationMessage(
      `Mise: Do you want to install ${toolName}`,
      "Yes",
      "No"
    );
    if (answer !== "Yes") {
      throw Error("User does not want to install");
    }

    this.output.appendLine(`Installing ${toolName}`);
    const installOutput = vscode.window.createOutputChannel(
      `Mise Install ${toolName}`
    );
    this.context.subscriptions.push(installOutput);

    // Progress notification with option to cancel
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Mise: Installing ${toolName}`,
        cancellable: true,
      },
      async (progress, token) => {
        const process = spawn("mise", ["install", toolName, "--yes"], {
          cwd: folder?.uri.fsPath,
        });
        process?.stdout?.on("data", (data) => {
          installOutput.append(`${data}`);
        });
        process?.stderr?.on("data", (data) => {
          installOutput.append(`${data}`);
        });

        token.onCancellationRequested(() => {
          process.kill();
        });

        return new Promise<void>(async (resolve) => {
          process.on("exit", (code) => {
            if (code === 0) {
              vscode.window.showInformationMessage(
                `Mise: Installed ${toolName}`
              );
            } else {
              vscode.window.showErrorMessage(
                `Mise: Install failed for ${toolName}`
              );
            }
            resolve();
          });
        });
      }
    );
  }

  async createSymlink(tool: any) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    mkdir(`${folder?.uri.fsPath}/.vscode/vscode-mise-installs`, {
      recursive: true,
    });
    const link = `${folder?.uri.fsPath}/.vscode/vscode-mise-installs/${tool.name}`;
    if (existsSync(link)) {
      console.log(await readlink(link), tool.install_path);
      if ((await readlink(link)) === tool.install_path) {
        // @TODO don't throw, return to let you reconfigure when already installed
        throw Error("Already configured correctly");
      } else {
        await rm(link);
      }
    }
    await symlink(
      `${tool.install_path}`,
      `${folder?.uri.fsPath}/.vscode/vscode-mise-installs/${tool.name}`,
      "dir"
    );
  }

  async updateConfig(tool: any) {
    const toolName = `${tool.name}@${tool?.version}`;
    const configuration = workspace.getConfiguration();
    const extensions = vscode.extensions.all.map((x) => x.id);

    if (tool.name === "deno" && extensions.includes("denoland.vscode-deno")) {
      configuration
        .update(
          "deno.path",
          ".vscode/vscode-mise-installs/deno/bin/deno",
          ConfigurationTarget.Workspace
        )
        .then(async () => {
          vscode.window.showInformationMessage(
            `Mise: Configured the extension denoland.vscode-deno to use ${toolName}`
          );
          setTimeout(async () => {
            await vscode.commands.executeCommand("deno.client.restart");
          }, 500);
        });
    }

    if (tool.name === "ruff" && extensions.includes("charliermarsh.ruff")) {
      configuration
        .update(
          "ruff.path",
          [".vscode/vscode-mise-installs/ruff/bin/ruff"],
          ConfigurationTarget.Workspace
        )
        .then(async () => {
          vscode.window.showInformationMessage(
            `Mise: Configured the the extension charliermarsh.ruff to use ${toolName}`
          );
          setTimeout(async () => {
            await vscode.commands.executeCommand("ruff.restart");
          }, 500);
        });
    }

    if (tool.name === "go" && extensions.includes("golang.go")) {
      configuration
        .update(
          "go.goroot",
          "${workspaceFolder}/.vscode/vscode-mise-installs/go",
          ConfigurationTarget.Workspace
        )
        .then(async () => {
          vscode.window.showInformationMessage(
            `Mise: Configured the extension golang.go to use ${toolName}`
          );
          setTimeout(async () => {
            await vscode.commands.executeCommand("go.languageserver.restart");
          }, 500);
        });
    }

    if (tool.name === "bun" && extensions.includes("oven.bun-vscode")) {
      configuration
        .update(
          "bun.runtime",
          ".vscode/vscode-mise-installs/bun/bin/bun",
          ConfigurationTarget.Workspace
        )
        .then(async () => {
          vscode.window.showInformationMessage(
            `Mise: Configured the extension oven.bun-vscode to use ${toolName}`
          );
        });
    }
  }
}

// This method is called when your extension is deactivated
export function deactivate() {}
