import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';
import { rolesApi } from '../lib/api/rolesApi';
import { useSessionContext } from '../lib/contexts/SessionContext';
import { t } from '../lib/i18n';
import { toast } from 'sonner';

type SimpleRole = { id: string; label?: string };

interface RoleContextBadgeGroupProps {
  className?: string;
  activeRoleId?: string;
  roles?: SimpleRole[];
  maxPreview?: number;
  showCurrentRole?: boolean;
  showRoleCount?: boolean;
  showRolePool?: boolean;
  showHint?: boolean;
}

export function RoleContextBadgeGroup({
  className,
  activeRoleId: activeRoleIdProp,
  roles,
  maxPreview = 4,
  showCurrentRole = true,
  showRoleCount = false,
  showRolePool = false,
  showHint = false,
}: RoleContextBadgeGroupProps) {
  const { roleId: contextRoleId } = useSessionContext();
  const usedActiveRoleId = activeRoleIdProp ?? contextRoleId;
  const [runtimeRoles, setRuntimeRoles] = useState<SimpleRole[]>([]);
  const [rolesLoadFailed, setRolesLoadFailed] = useState(false);
  const toastOnceRef = useRef(false);

  useEffect(() => {
    if (Array.isArray(roles)) return;
    let cancelled = false;
    setRolesLoadFailed(false);
    rolesApi
      .listRoles()
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !Array.isArray(res.roles)) {
          setRolesLoadFailed(true);
          if (!toastOnceRef.current) {
            toastOnceRef.current = true;
            toast.error(t("dashboard.rolesLoadError"), { description: t("composer.rolesLoadFailed") });
          }
          return;
        }
        setRuntimeRoles(res.roles.map((r) => ({ id: String(r.id), label: String(r.label || r.id) })));
      })
      .catch(() => {
        if (!cancelled) {
          setRolesLoadFailed(true);
          if (!toastOnceRef.current) {
            toastOnceRef.current = true;
            toast.error(t("dashboard.rolesLoadError"), { description: t("composer.rolesLoadFailed") });
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roles]);

  const usedRoles = Array.isArray(roles) ? roles : runtimeRoles;
  const activeRoleLabel = useMemo(() => {
    if (!usedActiveRoleId) return '未设置';
    if (rolesLoadFailed && !Array.isArray(roles)) return t("dashboard.rolesLoadError");
    return usedRoles.find((r) => r.id === usedActiveRoleId)?.label || usedActiveRoleId;
  }, [usedActiveRoleId, usedRoles, rolesLoadFailed, roles]);
  const rolePoolPreview = useMemo(() => usedRoles.slice(0, maxPreview).map((r) => r.label || r.id), [usedRoles, maxPreview]);

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {showCurrentRole && (
        <Badge variant="outline" className="text-[10px]">
          当前角色：{activeRoleLabel}
        </Badge>
      )}
      {showRoleCount && (
        <Badge variant="outline" className="text-[10px]">
          可用角色：{usedRoles.length}
        </Badge>
      )}
      {showRolePool && rolePoolPreview.length > 0 && (
        <Badge variant="outline" className="text-[10px]">
          角色池：{rolePoolPreview.join(' / ')}
        </Badge>
      )}
      {showHint && (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          单用户多角色：可在聊天区切换
        </Badge>
      )}
    </div>
  );
}

export default RoleContextBadgeGroup;
