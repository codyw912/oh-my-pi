{
  fetchurl,
  lib,
  stdenvNoCC,
}:

# Test-only dependency, using the deployed release flavor on the native platform.
# This installs through Nix; it never invokes Homebrew or a shell installer.
let
  releases = {
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-AbsvWHIWC3yY74+EvayA8sgh0E1LJMcavhQSdPrm/EY=";
    };
    x86_64-linux = {
      arch = "amd64";
      hash = "sha256-k1XgmNB7NJiYrw1qkDmnvRv55Qr+DDeAVEK8XcGJEYE=";
    };
  };
  release = releases.${stdenvNoCC.hostPlatform.system};
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "kata-continuation-fixture";
  version = "0.16.0";
  src = fetchurl {
    url = "https://github.com/kenn-io/kata/releases/download/v${finalAttrs.version}/kata_${finalAttrs.version}_homebrew_linux_${release.arch}.tar.gz";
    inherit (release) hash;
  };
  dontUnpack = true;
  installPhase = ''
    runHook preInstall
    install -d "$out/bin"
    tar -xzf "$src" -C "$out/bin" kata
    chmod 0755 "$out/bin/kata"
    runHook postInstall
  '';
  passthru.sourceRevision = "7050b84d367b8c94cd7a6cb4a556ab697cf0dfbc";
  meta = {
    description = "Pinned local Kata dependency for provider-free continuation checks";
    homepage = "https://github.com/kenn-io/kata";
    license = lib.licenses.mit;
    mainProgram = "kata";
    platforms = builtins.attrNames releases;
  };
})
