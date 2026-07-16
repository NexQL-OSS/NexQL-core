const fs = require('fs');
const path = require('path');

function main() {
  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const proPath = path.join(root, 'packages', 'pro', 'contributes.pro.json');

  if (!fs.existsSync(pkgPath)) {
    throw new Error('package.json not found');
  }
  if (!fs.existsSync(proPath)) {
    throw new Error('packages/pro/contributes.pro.json not found');
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const pro = JSON.parse(fs.readFileSync(proPath, 'utf8'));

  if (!pkg.contributes) {
    pkg.contributes = {};
  }

  // 1. Merge commands
  if (pro.commands && Array.isArray(pro.commands)) {
    if (!pkg.contributes.commands) {
      pkg.contributes.commands = [];
    }
    // Check duplicates
    const existingIds = new Set(pkg.contributes.commands.map(c => c.command));
    for (const cmd of pro.commands) {
      if (existingIds.has(cmd.command)) {
        throw new Error(`Duplicate command id during merge: ${cmd.command}`);
      }
      pkg.contributes.commands.push(cmd);
    }
  }

  // 2. Merge viewsContainers
  if (pro.viewsContainers) {
    if (!pkg.contributes.viewsContainers) {
      pkg.contributes.viewsContainers = {};
    }
    for (const containerKey of Object.keys(pro.viewsContainers)) {
      if (!pkg.contributes.viewsContainers[containerKey]) {
        pkg.contributes.viewsContainers[containerKey] = [];
      }
      const existingIds = new Set(pkg.contributes.viewsContainers[containerKey].map(x => x.id));
      for (const item of pro.viewsContainers[containerKey]) {
        if (!existingIds.has(item.id)) {
          pkg.contributes.viewsContainers[containerKey].push(item);
        }
      }
    }
  }

  // 3. Merge views
  if (pro.views) {
    if (!pkg.contributes.views) {
      pkg.contributes.views = {};
    }
    for (const viewKey of Object.keys(pro.views)) {
      if (!pkg.contributes.views[viewKey]) {
        pkg.contributes.views[viewKey] = [];
      }
      const existingIds = new Set(pkg.contributes.views[viewKey].map(x => x.id));
      for (const item of pro.views[viewKey]) {
        if (!existingIds.has(item.id)) {
          pkg.contributes.views[viewKey].push(item);
        }
      }
    }
  }

  // 4. Merge configuration
  if (pro.configuration && pro.configuration.properties) {
    if (!pkg.contributes.configuration) {
      pkg.contributes.configuration = { properties: {} };
    }
    if (!pkg.contributes.configuration.properties) {
      pkg.contributes.configuration.properties = {};
    }
    for (const key of Object.keys(pro.configuration.properties)) {
      if (pkg.contributes.configuration.properties[key]) {
        throw new Error(`Duplicate configuration key during merge: ${key}`);
      }
      pkg.contributes.configuration.properties[key] = pro.configuration.properties[key];
    }
  }

  // 5. Merge menus
  if (pro.menus) {
    if (!pkg.contributes.menus) {
      pkg.contributes.menus = {};
    }
    for (const menuKey of Object.keys(pro.menus)) {
      if (!pkg.contributes.menus[menuKey]) {
        pkg.contributes.menus[menuKey] = [];
      }
      const menuList = pro.menus[menuKey];
      if (Array.isArray(menuList)) {
        for (const item of menuList) {
          pkg.contributes.menus[menuKey].push(item);
        }
      }
    }
  }

  // 6. Merge mcpServerDefinitionProviders
  if (pro.mcpServerDefinitionProviders && Array.isArray(pro.mcpServerDefinitionProviders)) {
    if (!pkg.contributes.mcpServerDefinitionProviders) {
      pkg.contributes.mcpServerDefinitionProviders = [];
    }
    const existingIds = new Set(pkg.contributes.mcpServerDefinitionProviders.map(p => p.id));
    for (const provider of pro.mcpServerDefinitionProviders) {
      if (!existingIds.has(provider.id)) {
        pkg.contributes.mcpServerDefinitionProviders.push(provider);
      }
    }
  }

  // 7. Merge keybindings
  if (pro.keybindings && Array.isArray(pro.keybindings)) {
    if (!pkg.contributes.keybindings) {
      pkg.contributes.keybindings = [];
    }
    const existingCommands = new Set(pkg.contributes.keybindings.map(k => k.command));
    for (const kb of pro.keybindings) {
      if (!existingCommands.has(kb.command)) {
        pkg.contributes.keybindings.push(kb);
      }
    }
  }

  // 8. Merge activationEvents (top-level, not under contributes)
  if (pro.activationEvents && Array.isArray(pro.activationEvents)) {
    if (!pkg.activationEvents) {
      pkg.activationEvents = [];
    }
    const existingEvents = new Set(pkg.activationEvents);
    for (const event of pro.activationEvents) {
      if (!existingEvents.has(event)) {
        pkg.activationEvents.push(event);
      }
    }
  }

  // Save merged package.json
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('Successfully merged contributes.pro.json into package.json.');
}

main();
