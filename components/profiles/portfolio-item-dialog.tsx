"use client"

import { ImagePlus, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { ProductFormat } from "@/lib/db/schema/enums"
import {
  addPortfolioItemAction,
  requestPortfolioImageUpload,
  updatePortfolioItemAction,
} from "@/lib/profiles/actions"
import {
  PORTFOLIO_DESCRIPTION_MAX,
  PORTFOLIO_TITLE_MAX,
  PORTFOLIO_URL_MAX,
  PRODUCT_FORMAT_LABELS,
  PRODUCT_FORMAT_VALUES,
  type ProfileFormSource,
} from "@/lib/profiles/fields"
import {
  checkPortfolioImage,
  PORTFOLIO_IMAGE_ACCEPT,
  PORTFOLIO_IMAGE_POLICY,
} from "@/lib/profiles/image-policy"
import { formatBytes } from "@/lib/storage/limits"

import { describe, Field, FormErrorAlert, NativeSelect, useFormAction } from "./form-kit"

export type PortfolioItemView = {
  id: string
  title: string
  url: string | null
  description: string | null
  format: ProductFormat | null
  isShipped: boolean
  /** `/api/portfolio/<id>/image?v=…`, or null without an image. */
  imageSrc: string | null
}

const FIELDS = [
  "title",
  "url",
  "description",
  "format",
  "isShipped",
  "imageKey",
  "removeImage",
] as const

/**
 * Add a portfolio project, or edit one (`item`), in a dialog. Closes after a successful save; the
 * page re-renders with the new list.
 */
export function PortfolioItemDialog({
  source,
  item,
  trigger,
}: {
  source: ProfileFormSource
  item?: PortfolioItemView
  trigger?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // A fresh form (and no old errors) every time the dialog opens.
        if (next) setFormKey((key) => key + 1)
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={item ? "ghost" : "default"} size={item ? "sm" : "default"}>
            {item ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {item ? (
              <>
                Edit<span className="sr-only"> {item.title}</span>
              </>
            ) : (
              "Add a project"
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? "Edit project" : "Add a project"}</DialogTitle>
          <DialogDescription>
            Something you built: an app, a tool, a template. Creators see it on your profile.
          </DialogDescription>
        </DialogHeader>
        <PortfolioItemForm
          key={formKey}
          source={source}
          item={item}
          onSaved={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function PortfolioItemForm({
  source,
  item,
  onSaved,
}: {
  source: ProfileFormSource
  item?: PortfolioItemView
  onSaved: () => void
}) {
  const id = useId()
  const form = useFormAction(async (formData: FormData) => {
    const result = item
      ? await updatePortfolioItemAction(formData)
      : await addPortfolioItemAction(formData)
    if (result.ok) onSaved()
    return result
  })
  const ids = {
    title: `${id}-title`,
    url: `${id}-url`,
    description: `${id}-description`,
    format: `${id}-format`,
    shipped: `${id}-shipped`,
    image: `${id}-image`,
  }
  const [uploading, setUploading] = useState(false)
  const shippedValue = form.error
    ? form.valueOf("isShipped", "") === "on"
    : (item?.isShipped ?? false)

  return (
    <form action={form.formAction} className="space-y-5" noValidate>
      <input type="hidden" name="from" value={source} />
      {item ? <input type="hidden" name="itemId" value={item.id} /> : null}
      {form.error && form.hasFormError(FIELDS) ? (
        <FormErrorAlert message={form.error.error} />
      ) : null}

      <Field id={ids.title} label="Title" error={form.fieldError("title")}>
        <Input
          id={ids.title}
          name="title"
          defaultValue={form.valueOf("title", item?.title ?? "")}
          required
          maxLength={PORTFOLIO_TITLE_MAX}
          placeholder="Invoice generator for freelancers"
          {...describe(ids.title, { error: form.fieldError("title") })}
        />
      </Field>

      <Field
        id={ids.url}
        label="Link"
        optional
        hint="Where people can see or try it."
        error={form.fieldError("url")}
      >
        <Input
          id={ids.url}
          name="url"
          type="url"
          inputMode="url"
          defaultValue={form.valueOf("url", item?.url ?? "")}
          maxLength={PORTFOLIO_URL_MAX}
          placeholder="https://"
          {...describe(ids.url, { hint: true, error: form.fieldError("url") })}
        />
      </Field>

      <Field
        id={ids.description}
        label="What it does"
        optional
        error={form.fieldError("description")}
      >
        <Textarea
          id={ids.description}
          name="description"
          defaultValue={form.valueOf("description", item?.description ?? "")}
          maxLength={PORTFOLIO_DESCRIPTION_MAX}
          rows={3}
          {...describe(ids.description, { error: form.fieldError("description") })}
        />
      </Field>

      <Field id={ids.format} label="Format" optional error={form.fieldError("format")}>
        <NativeSelect
          id={ids.format}
          name="format"
          defaultValue={form.valueOf("format", item?.format ?? "")}
          {...describe(ids.format, { error: form.fieldError("format") })}
        >
          <option value="">Not sure</option>
          {PRODUCT_FORMAT_VALUES.map((format) => (
            <option key={format} value={format}>
              {PRODUCT_FORMAT_LABELS[format]}
            </option>
          ))}
        </NativeSelect>
      </Field>

      <ImagePicker
        id={ids.image}
        currentSrc={item?.imageSrc ?? null}
        title={item?.title}
        error={form.fieldError("imageKey")}
        onUploadingChange={setUploading}
      />

      <label htmlFor={ids.shipped} className="flex items-start gap-3 text-sm">
        <input
          id={ids.shipped}
          type="checkbox"
          name="isShipped"
          defaultChecked={shippedValue}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="font-medium">It&apos;s shipped</span>
          <span className="block text-muted-foreground">People can use it today.</span>
        </span>
      </label>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={form.pending || uploading}>
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {item ? "Save project" : "Add project"}
        </Button>
      </DialogFooter>
    </form>
  )
}

type ImageState =
  | { state: "current" }
  | { state: "uploading"; previewUrl: string }
  | { state: "uploaded"; key: string; previewUrl: string }
  | { state: "removed" }

/**
 * The project image: a screenshot or cover (PNG, JPEG, WebP or GIF, §14 allow-list). Choosing a
 * file uploads it straight to storage through a signed URL; the form then sends the upload's key
 * (`imageKey`). "Remove image" sends `removeImage`. Saving copies the upload to a key of the
 * project's own and checks that copy (lib/profiles/portfolio-image.ts).
 */
function ImagePicker({
  id,
  currentSrc,
  title,
  error,
  onUploadingChange,
}: {
  id: string
  currentSrc: string | null
  title?: string
  error?: string
  onUploadingChange: (uploading: boolean) => void
}) {
  const [image, setImage] = useState<ImageState>({ state: "current" })
  const [message, setMessage] = useState<string | null>(null)
  const previewUrl =
    image.state === "uploading" || image.state === "uploaded" ? image.previewUrl : null

  // Free the local preview when it is replaced or the dialog closes.
  useEffect(() => {
    if (!previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const shownSrc = previewUrl ?? (image.state === "current" && currentSrc ? currentSrc : null)
  const shownError = message ?? error

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    setMessage(null)
    const check = checkPortfolioImage({ contentType: file.type, sizeBytes: file.size })
    if (!check.ok) {
      setMessage(check.message)
      return
    }
    const localUrl = URL.createObjectURL(file)
    setImage({ state: "uploading", previewUrl: localUrl })
    onUploadingChange(true)
    try {
      const upload = await requestPortfolioImageUpload({
        contentType: check.contentType,
        sizeBytes: file.size,
      })
      if (!upload.ok) throw new Error(upload.error)
      const response = await fetch(upload.data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": upload.data.contentType },
        body: file,
      })
      if (!response.ok) throw new Error("upload failed")
      setImage({ state: "uploaded", key: upload.data.key, previewUrl: localUrl })
    } catch (failure) {
      setImage({ state: "current" })
      setMessage(
        failure instanceof Error && failure.message !== "upload failed" && failure.message
          ? failure.message
          : "Your image didn't upload. Check your connection and try again.",
      )
    } finally {
      onUploadingChange(false)
    }
  }

  return (
    <div className="space-y-2">
      <p id={`${id}-label`} className="text-sm leading-none font-medium">
        Image <span className="font-normal text-muted-foreground">(optional)</span>
      </p>
      {image.state === "uploaded" ? (
        <input type="hidden" name="imageKey" value={image.key} />
      ) : null}
      {image.state === "removed" ? <input type="hidden" name="removeImage" value="on" /> : null}

      <div className="flex items-center gap-3">
        <div className="relative flex aspect-[4/3] w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {shownSrc ? (
            // A signed or local preview URL: next/image would need every storage host configured.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shownSrc}
              alt={title ? `Image of ${title}` : "Project image"}
              className="size-full object-cover"
            />
          ) : (
            <ImagePlus className="size-6 text-muted-foreground" aria-hidden="true" />
          )}
          {image.state === "uploading" ? (
            <span className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              <span className="sr-only">Uploading…</span>
            </span>
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-1">
          <label
            htmlFor={id}
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium shadow-xs hover:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
          >
            <ImagePlus className="size-4" aria-hidden="true" />
            {shownSrc ? "Replace image" : "Choose image"}
            <input
              id={id}
              type="file"
              accept={PORTFOLIO_IMAGE_ACCEPT}
              onChange={onFileChange}
              disabled={image.state === "uploading"}
              aria-describedby={`${id}-hint${shownError ? ` ${id}-error` : ""}`}
              aria-invalid={shownError ? true : undefined}
              className="sr-only"
            />
          </label>
          {shownSrc && image.state !== "uploading" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setMessage(null)
                setImage(currentSrc ? { state: "removed" } : { state: "current" })
              }}
            >
              <Trash2 aria-hidden="true" />
              Remove image
            </Button>
          ) : null}
        </div>
      </div>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {image.state === "uploaded"
          ? "Uploaded. Save the project to use it."
          : `A screenshot or cover. PNG, JPEG, WebP or GIF, up to ${formatBytes(PORTFOLIO_IMAGE_POLICY.maxBytes)}.`}
      </p>
      {shownError ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      ) : null}
    </div>
  )
}
