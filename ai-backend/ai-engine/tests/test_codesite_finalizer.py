from __future__ import annotations
import subprocess, sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shadow.codesite_agent_workspace import CodeSiteExecutionBinding, create_codesite_agent_worktree, remove_codesite_agent_worktree
from shadow.codesite_finalizer import CodeSiteFinalizationError, finalize_codesite_worktree

def git(cwd, *args): return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
def setup(tmp_path):
    source=tmp_path/'source'; source.mkdir(); git(source,'init'); git(source,'config','user.email','x@y.z'); git(source,'config','user.name','x'); (source/'a.txt').write_text('base\n'); git(source,'add','.'); git(source,'commit','-m','base'); root=tmp_path/'overlays'; root.mkdir(); b=CodeSiteExecutionBinding('demo','project-1','agent-1','lease-1','txn-1',git(source,'rev-parse','HEAD')); return source,b,root
def test_finalizer_runs_real_check_then_lands(tmp_path):
    source,b,root=setup(tmp_path); wt=create_codesite_agent_worktree(source_workspace=source,overlay_root=root,binding=b)
    try:
      (wt.path/'a.txt').write_text('landed\n')
      paths=finalize_codesite_worktree(source_workspace=source,worktree=wt,binding=b,allowed_paths=('*.txt',),test_command=[sys.executable,'-c',"from pathlib import Path; assert Path('a.txt').read_text() == 'landed\\n'"])
      assert paths==['a.txt']; assert (source/'a.txt').read_text()=='landed\n'
    finally: remove_codesite_agent_worktree(wt)
def test_finalizer_rejects_out_of_route_change(tmp_path):
    source,b,root=setup(tmp_path); wt=create_codesite_agent_worktree(source_workspace=source,overlay_root=root,binding=b)
    try:
      (wt.path/'blocked.py').write_text('x\n')
      with pytest.raises(CodeSiteFinalizationError,match='outside'): finalize_codesite_worktree(source_workspace=source,worktree=wt,binding=b,allowed_paths=('src/**',),test_command=[sys.executable,'-c','pass'])
      assert not (source/'blocked.py').exists()
    finally: remove_codesite_agent_worktree(wt)
