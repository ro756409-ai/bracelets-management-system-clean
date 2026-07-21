import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Edit, Building2, ToggleLeft, ToggleRight } from "lucide-react";
import { toast } from "sonner";

export default function Businesses() {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingBusiness, setEditingBusiness] = useState<any>(null);
  const [formData, setFormData] = useState({ name: "", slug: "" });

  const { data: businesses, isLoading } = trpc.businesses.list.useQuery();
  const utils = trpc.useUtils();

  const createMutation = trpc.businesses.create.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      setIsAddOpen(false);
      setFormData({ name: "", slug: "" });
      toast.success("تم إنشاء النشاط بنجاح");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const updateMutation = trpc.businesses.update.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      setEditingBusiness(null);
      toast.success("تم تحديث النشاط بنجاح");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const toggleMutation = trpc.businesses.update.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      toast.success("تم تحديث الحالة");
    },
  });

  const handleCreate = () => {
    if (!formData.name.trim()) return;
    const slug = formData.slug.trim() || formData.name.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");
    createMutation.mutate({ name: formData.name.trim(), slug });
  };

  const handleUpdate = () => {
    if (!editingBusiness || !formData.name.trim()) return;
    updateMutation.mutate({
      id: editingBusiness.id,
      name: formData.name.trim(),
      slug: formData.slug.trim() || undefined,
    });
  };

  const handleToggle = (business: any) => {
    toggleMutation.mutate({
      id: business.id,
      isActive: !business.isActive,
    });
  };

  const openEdit = (business: any) => {
    setEditingBusiness(business);
    setFormData({ name: business.name, slug: business.slug || "" });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة الأنشطة</h1>
          <p className="text-muted-foreground mt-1">إدارة الأنشطة التجارية والبراندات</p>
        </div>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 ml-2" />
              إضافة نشاط جديد
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>إضافة نشاط جديد</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <Label>اسم النشاط</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="مثال: فرحات للنحاس"
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Slug (اختياري)</Label>
                <Input
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                  placeholder="farhat-brass"
                  className="mt-1"
                  dir="ltr"
                />
                <p className="text-xs text-muted-foreground mt-1">يُستخدم كمعرف فريد. يُنشأ تلقائياً إذا تُرك فارغاً.</p>
              </div>
              <Button onClick={handleCreate} disabled={createMutation.isPending} className="w-full">
                {createMutation.isPending ? "جاري الإنشاء..." : "إنشاء النشاط"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            الأنشطة التجارية ({businesses?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">#</TableHead>
                <TableHead className="text-right">اسم النشاط</TableHead>
                <TableHead className="text-right">Slug</TableHead>
                <TableHead className="text-right">الحالة</TableHead>
                <TableHead className="text-right">تاريخ الإنشاء</TableHead>
                <TableHead className="text-right">إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {businesses?.map((business: any) => (
                <TableRow key={business.id}>
                  <TableCell>{business.id}</TableCell>
                  <TableCell className="font-medium">{business.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm" dir="ltr">
                    {business.slug}
                  </TableCell>
                  <TableCell>
                    <Badge variant={business.isActive ? "default" : "secondary"}>
                      {business.isActive ? "نشط" : "معطل"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {business.createdAt ? new Date(business.createdAt).toLocaleDateString("ar-EG") : "-"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(business)}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggle(business)}
                        disabled={toggleMutation.isPending}
                      >
                        {business.isActive ? (
                          <ToggleRight className="h-4 w-4 text-green-600" />
                        ) : (
                          <ToggleLeft className="h-4 w-4 text-gray-400" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingBusiness} onOpenChange={(open) => !open && setEditingBusiness(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تعديل النشاط</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label>اسم النشاط</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                className="mt-1"
                dir="ltr"
              />
            </div>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending} className="w-full">
              {updateMutation.isPending ? "جاري التحديث..." : "حفظ التعديلات"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
