# Takes `{ pkgs }` (unused so far) so tools needing package references — mypy
# with extra Python packages, say — can be added without touching flake.nix.
{ ... }:
{
  projectRootFile = "flake.nix";
  programs.nixfmt.enable = true;
  programs.prettier.enable = true;
  programs.shellcheck.enable = true;
  programs.shfmt.enable = true;

  settings.global.excludes = [
    "*.lock"
    "*.png"
    "*.svg"
  ];
}
