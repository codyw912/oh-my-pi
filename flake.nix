{
  description = "OMP coding agent and development environment";

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable dropped Intel macOS in 26.11; keep that supported
    # platform on the final stable branch that still receives security fixes.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # bun2nix's per-system helper packages must use the same Intel-compatible
    # package set as the derivation consuming its overlay.
    bun2nix-darwin-x64 = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs-darwin-x64";
      inputs.systems.url = "github:nix-systems/x86_64-darwin";
    };

    nix-bun = {
      url = "github:ryoppippi/nix-bun";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Pinned Sjujperpowers baseline plus the deployed onboarding patch applied
    # in checks. Never an ambient checkout.
    sjujperpowers = {
      url = "github:codyw912/sjujperpowers/fb3395eb3e2e9808fc516fe5d537f5b42a737b2d";
      flake = false;
    };
  };

  outputs =
    {
      self,
      bun2nix,
      bun2nix-darwin-x64,
      nix-bun,
      nixpkgs,
      nixpkgs-darwin-x64,
      rust-overlay,
      sjujperpowers,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs;
      bun2nixFor = system: if system == "x86_64-darwin" then bun2nix-darwin-x64 else bun2nix;
      pkgsFor =
        system:
        import (nixpkgsFor system) {
          inherit system;
          overlays = [
            rust-overlay.overlays.default
            (bun2nixFor system).overlays.default
            (final: _previous: {
              # Instantiate the pinned upstream binary against this package
              # set so Intel macOS does not re-enter nix-bun's unstable input.
              bun = final.callPackage (nix-bun.outPath + "/package.nix") {
                sourcesFile = nix-bun.outPath + "/versions/1.4.0.json";
              };
            })
          ];
        };
      packageFor =
        system:
        let
          pkgs = pkgsFor system;
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in
        pkgs.callPackage ./nix/package.nix {
          inherit rustToolchain;
          source = self.outPath;
        };
    in
    {
      packages = forAllSystems (system: {
        default = packageFor system;
        omp = packageFor system;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/omp";
          meta.description = "Run OMP";
        };
        omp = self.apps.${system}.default;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in
        {
          default = import ./nix/dev-shell.nix { inherit pkgs rustToolchain; };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          inherit (pkgs) lib;
          homeManagerEvaluation = pkgs.lib.evalModules {
            specialArgs = { inherit pkgs; };
            modules = [
              {
                options.home.packages = pkgs.lib.mkOption {
                  type = pkgs.lib.types.listOf pkgs.lib.types.package;
                  default = [ ];
                };
                options.home.activation = pkgs.lib.mkOption {
                  type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
                  default = { };
                };
              }
              self.homeManagerModules.default
              {
                programs.omp.enable = true;
                programs.omp.settings.startup.quiet = true;
              }
            ];
          };
          nixosEvaluation = pkgs.lib.evalModules {
            specialArgs = { inherit pkgs; };
            modules = [
              {
                options.environment.systemPackages = pkgs.lib.mkOption {
                  type = pkgs.lib.types.listOf pkgs.lib.types.package;
                  default = [ ];
                };
              }
              self.nixosModules.default
              { programs.omp.enable = true; }
            ];
          };
          modulesEvaluate =
            assert builtins.elem self.packages.${system}.default homeManagerEvaluation.config.home.packages;
            assert homeManagerEvaluation.config.home.activation ? ompConfig;
            assert builtins.elem self.packages.${system}.default
              nixosEvaluation.config.environment.systemPackages;
            pkgs.runCommand "omp-module-evaluation" { } "touch $out";
          sjujperpowersRev = "fb3395eb3e2e9808fc516fe5d537f5b42a737b2d";
          continuationLinuxChecks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
            let
              patchedSjujperpowers = pkgs.applyPatches {
                name = "sjujperpowers-onboarding";
                src = sjujperpowers;
                patches = [
                  ./nix/patches/sjujperpowers-backend-onboarding.patch
                  ./nix/patches/sjujperpowers-continuation-recovery.patch
                ];
              };
              durabilityTestFiles = [
                "packages/coding-agent/test/continuation-store.test.ts"
                "packages/coding-agent/test/session-storage.test.ts"
                "packages/coding-agent/test/session-manager-close-race.test.ts"
                "packages/coding-agent/test/session-manager/stage-continuation.test.ts"
                "packages/agent/test/tool-execution-boundary.test.ts"
                "packages/coding-agent/test/async-job-manager.test.ts"
              ];
              baselineTestFiles = [
                "packages/utils/test/file-lock.test.ts"
                "packages/natives/test/file-lock.test.ts"
                "packages/coding-agent/test/session-storage.test.ts"
                "packages/coding-agent/test/agent-session-new-session-boundary.test.ts"
                "packages/coding-agent/test/session-manager/new-session-boundary.test.ts"
              ];
              admissionTestFiles = durabilityTestFiles ++ [
                "packages/coding-agent/test/continuation-policy.test.ts"
                "packages/coding-agent/test/continuation-request.test.ts"
                "packages/coding-agent/test/continuation-controller.test.ts"
                "packages/coding-agent/test/continuation-admission-matrix.test.ts"
                "packages/coding-agent/test/agent-session-continuation-admission.test.ts"
                "packages/coding-agent/test/continuation-auxiliary.test.ts"
                "packages/coding-agent/test/continuation-briefing.test.ts"
                "packages/coding-agent/test/continuation-evaluation.test.ts"
              ];
              handoffTestFiles = [
                "packages/coding-agent/test/agent-session-continuation.test.ts"
                "packages/coding-agent/test/session-manager/stage-continuation.test.ts"
                "packages/coding-agent/test/advisor/advisor.test.ts"
                "packages/coding-agent/test/session-stop-continuation-recap.test.ts"
                "packages/coding-agent/test/continuation-services.test.ts"
                "packages/coding-agent/test/continuation-advisor.test.ts"
                "packages/coding-agent/test/launch"
                "packages/coding-agent/test/tools/hub/launch-compat.test.ts"
                "packages/coding-agent/test/agent-session-async-delivery.test.ts"
                "packages/coding-agent/test/async-yield-queue.test.ts"
              ];
              compactionTestFiles = [
                "packages/coding-agent/test/session-manager/build-context.test.ts"
                "packages/coding-agent/test/agent-session-eager-compaction.test.ts"
                "packages/coding-agent/test/agent-session-mid-turn-compaction-dead-end.test.ts"
                "packages/coding-agent/test/agent-session-compaction-cancellation.test.ts"
                "packages/coding-agent/test/agent-session-auto-compaction-progress-guard.test.ts"
                "packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts"
                "packages/coding-agent/test/agent-session-goal-midrun-compaction.test.ts"
                "packages/coding-agent/test/compaction-speculation.test.ts"
                "packages/coding-agent/test/compaction-lifecycle.test.ts"
                "packages/coding-agent/test/compaction.test.ts"
              ];
              continuationCheck =
                args:
                pkgs.callPackage ./nix/continuation-local-check.nix (
                  {
                    omp = self.packages.${system}.default;
                    source = self.outPath;
                    sjujperpowersSource = patchedSjujperpowers;
                    sourceRev = self.rev or self.dirtyRev or "dirty";
                    inherit sjujperpowersRev;
                  }
                  // args
                );
            in
            {
              continuation-baseline = continuationCheck {
                pname = "omp-continuation-baseline";
                runBaseline = true;
                testFiles = baselineTestFiles;
              };
              continuation-durability = continuationCheck {
                pname = "omp-continuation-durability";
                testFiles = durabilityTestFiles;
              };
              continuation-admission = continuationCheck {
                pname = "omp-continuation-admission";
                testFiles = admissionTestFiles;
              };
              continuation-handoff = continuationCheck {
                pname = "omp-continuation-handoff";
                testFiles = handoffTestFiles;
              };
              continuation-local = continuationCheck {
                pname = "omp-continuation-local";
                kata = pkgs.callPackage ./nix/continuation-kata.nix { };
                runWorkflowTests = true;
                testFiles = lib.unique (
                  admissionTestFiles
                  ++ handoffTestFiles
                  ++ compactionTestFiles
                  ++ baselineTestFiles
                  ++ [
                    "packages/coding-agent/test/continuation-local.test.ts"
                    "packages/coding-agent/test/continuation-kata.test.ts"
                    "packages/coding-agent/test/continuation-owner-certification.test.ts"
                  ]
                );
              };
            }
          );
        in
        {
          bun-lock = pkgs.runCommand "omp-bun-lock" { nativeBuildInputs = [ pkgs.bun2nix ]; } ''
            cp -R ${self.outPath} source
            chmod -R u+w source
            cd source
            mv nix/bun.nix nix/bun.expected.nix
            bun2nix -l bun.lock -c ../ -o nix/bun.nix
            sed -i -e '$a\' nix/bun.nix
            diff -u nix/bun.expected.nix nix/bun.nix
            touch "$out"
          '';
          modules = modulesEvaluate;
          omp = self.packages.${system}.default;
        }
        // continuationLinuxChecks
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);

      overlays.default = _final: previous: {
        omp = self.packages.${previous.stdenv.hostPlatform.system}.default;
      };

      homeManagerModules.default = import ./nix/home-manager.nix { inherit self; };
      homeManagerModules.omp = self.homeManagerModules.default;
      nixosModules.default = import ./nix/nixos-module.nix { inherit self; };
      nixosModules.omp = self.nixosModules.default;
    };
}
