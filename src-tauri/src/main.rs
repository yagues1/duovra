// Evita la consola adicional en Windows en compilaciones release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    duovra_lib::run()
}
