fn main() {
    println!("Current exe: {:?}", std::env::current_exe());
    if let Ok(path) = std::env::current_exe() {
        if let Some(parent) = path.parent() {
            let runner = parent.join("runner");
            println!("Constructed runner path: {:?}", runner);
            println!("Runner exists: {}", runner.exists());
        }
    }
}
