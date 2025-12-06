use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use uuid::Uuid;
use std::fs;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub id: String,
    pub path: String,
    pub parents: Vec<String>,
    pub children: Vec<String>,
    pub last_modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleGraph {
    pub modules: HashMap<String, ModuleInfo>,
    pub entry_point: String,
}

impl ModuleGraph {
    pub fn new(entry_point: String) -> Self {
        Self {
            modules: HashMap::new(),
            entry_point,
        }
    }

    pub fn add_module(&mut self, path: String, children: Vec<String>) {
        let id = path.clone(); // Use path as ID for simplicity
        let module = ModuleInfo {
            id: id.clone(),
            path: path.clone(),
            parents: Vec::new(),
            children: children.clone(),
            last_modified: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs(),
        };
        self.modules.insert(id.clone(), module);

        // Update parents
        for child in children {
            if let Some(child_module) = self.modules.get_mut(&child) {
                if !child_module.parents.contains(&id) {
                    child_module.parents.push(id.clone());
                }
            } else {
                // Child doesn't exist yet, create a placeholder or handle later
                // For now, we assume we process files in an order or handle this in a second pass
                // But simpler: just store the relationship
            }
        }
    }
    
    // Rebuild parents from children
    pub fn rebuild_parents(&mut self) {
        let mut parent_map: HashMap<String, Vec<String>> = HashMap::new();
        for (id, module) in &self.modules {
            for child in &module.children {
                parent_map.entry(child.clone()).or_default().push(id.clone());
            }
        }
        
        for (id, module) in self.modules.iter_mut() {
            if let Some(parents) = parent_map.get(id) {
                module.parents = parents.clone();
            } else {
                module.parents.clear();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub session_id: String,
    pub timestamp: u64,
    pub changed_modules: Vec<String>,
    pub removed_modules: Vec<String>,
    pub reload_needed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePayload {
    pub manifest: UpdateManifest,
    pub modules: HashMap<String, String>, // id -> content
}

pub struct BuildSession {
    pub session_id: String,
    pub graph: ModuleGraph,
    pub workspace_root: PathBuf,
    pub session_hash: String,
}

impl BuildSession {
    pub fn new(workspace_root: PathBuf) -> Self {
        let session_id = Uuid::new_v4().to_string();
        let session_hash = Uuid::new_v4().to_string(); // Simple hash for now
        Self {
            session_id,
            graph: ModuleGraph::new("".to_string()),
            workspace_root,
            session_hash,
        }
    }

    pub fn scan_dependencies(&mut self, entry_file: &str) {
        // This is a simplified dependency scanner.
        // In a real world, we'd use a proper parser for the language.
        // Here we just look for #include "..." or import ...
        
        let mut visited = HashSet::new();
        let mut queue = vec![entry_file.to_string()];
        
        self.graph.entry_point = entry_file.to_string();
        self.graph.modules.clear();

        while let Some(file_path) = queue.pop() {
            if visited.contains(&file_path) {
                continue;
            }
            visited.insert(file_path.clone());

            let full_path = self.workspace_root.join(&file_path);
            if let Ok(content) = fs::read_to_string(&full_path) {
                let children = self.parse_imports(&content, &file_path);
                self.graph.add_module(file_path.clone(), children.clone());
                
                for child in children {
                    if !visited.contains(&child) {
                        queue.push(child);
                    }
                }
            }
        }
        
        self.graph.rebuild_parents();
    }

    fn parse_imports(&self, content: &str, current_file: &str) -> Vec<String> {
        let mut imports = Vec::new();
        // Very basic parser
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with("#include \"") {
                if let Some(end) = line[10..].find('"') {
                    let import = &line[10..10+end];
                    // Resolve relative path
                    // For simplicity, assume flat or relative to root for now, 
                    // or implement basic relative path resolution
                    imports.push(import.to_string());
                }
            }
            // Add other languages as needed (e.g. Rust mod/use, JS import)
        }
        imports
    }

    pub fn incremental_compile(&mut self, changed_files: Vec<String>) -> Option<UpdatePayload> {
        // 1. Identify affected modules
        // For now, we just take the changed files. 
        // In a real system, we'd traverse up the parents to see what needs recompilation.
        
        let mut reload_needed = false;
        let mut affected_modules = HashSet::new();
        for file in &changed_files {
            if file.ends_with("Cargo.toml") || file.ends_with("package.json") {
                reload_needed = true;
            }
            affected_modules.insert(file.clone());
            // Add parents? If we are just sending updated code for HMR, maybe just the file.
            // If we are recompiling a binary, we need to re-link.
            // The request says "outputs only changed modules".
        }

        if affected_modules.is_empty() {
            return None;
        }

        let mut modules_content = HashMap::new();
        for module_id in &affected_modules {
            let full_path = self.workspace_root.join(module_id);
            if let Ok(content) = fs::read_to_string(full_path) {
                modules_content.insert(module_id.clone(), content);
            }
        }

        let manifest = UpdateManifest {
            session_id: self.session_id.clone(),
            timestamp: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs(),
            changed_modules: affected_modules.into_iter().collect(),
            removed_modules: Vec::new(), // Handle deletions later
            reload_needed,
        };

        Some(UpdatePayload {
            manifest,
            modules: modules_content,
        })
    }
    
    pub fn validate_session(&self, hash: &str) -> bool {
        self.session_hash == hash
    }
}
