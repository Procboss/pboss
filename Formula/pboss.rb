class Pboss < Formula
  desc "Universal, production-grade process manager built on Bun native APIs"
  homepage "https://procboss.com"
  url "https://github.com/procboss/pboss/archive/refs/heads/main.tar.gz"
  version "1.1.0"
  license "GPL-3.0-only"

  depends_on "bun" => :build

  def install
    system "bun", "install"
    system "bun", "build", "--compile", "--minify", "--bytecode", "./src/index.ts", "--outfile", bin/"pboss"
  end

  test do
    assert_match "pboss", shell_output("#{bin}/pboss --version")
  end
end
